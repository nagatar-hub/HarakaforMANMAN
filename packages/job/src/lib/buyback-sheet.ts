import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  GeneratedPageRow,
  OrderListItemRow,
  PreparedCardRow,
  StorePricingSettings,
} from '@haraka/shared';
import { replaceSheetValues } from './google-sheets.js';
import { loadStorePricingSettings } from './pricing-settings.js';
import { applyCurrentShinsokuBoxPrices, loadShinsokuBoxPriceMap } from './shinsoku-box-price-source.js';
import { isBoxRow } from './box-row.js';
import { STORE_NAME } from './store.js';

const DEFAULT_STORE_NAME = 'manman';
const DEFAULT_SPREADSHEET_ID = '1wEbAwrpoLTsRT7eD6aQJcvzzb0SDViCiatmIiGyqFL0';
const TARGET_SHEET_ID = 0;
const QUERY_BATCH_SIZE = 200;

export const BUYBACK_SHEET_HEADERS = [
  '商品ID',
  '名称',
  '種別',
  'エキスパンション',
  'リスト番号',
  'レアリティ',
  '画像',
  '買取価格',
  '更新日',
] as const;

const FRANCHISE_ORDER: Record<string, number> = {
  Pokemon: 0,
  'YU-GI-OH!': 1,
  'ONE PIECE': 2,
  'WEISS SCHWARZ': 3,
  'DRAGON BALL': 4,
};

type SheetCell = string | number | boolean | null;
type PublishPage = Pick<
  GeneratedPageRow,
  'franchise' | 'page_index' | 'card_ids' | 'status' | 'kind'
>;
type PublishPreparedCard = Pick<
  PreparedCardRow,
  | 'id'
  | 'run_id'
  | 'order_list_item_id'
  | 'franchise'
  | 'card_name'
  | 'grade'
  | 'list_no'
  | 'image_url'
  | 'alt_image_url'
  | 'rarity'
  | 'tag'
  | 'price_high'
  | 'image_status'
  | 'price_source_date'
>;
type PublishOrderListItem = Pick<
  OrderListItemRow,
  | 'id'
  | 'import_id'
  | 'franchise'
  | 'excel_product_id'
  | 'card_name'
  | 'grade'
  | 'expansion'
  | 'list_no'
  | 'rarity'
>;

export type BuybackSheetPublishResult = {
  status: 'completed' | 'skipped';
  rowCount: number;
  contentHash: string | null;
  spreadsheetId: string | null;
};

export function isBuybackSheetPublishDisabled(): boolean {
  return ['1', 'true'].includes(
    process.env.BUYBACK_SHEET_PUBLISH_DISABLED?.trim().toLowerCase() ?? '',
  );
}

export function resolveBuybackSpreadsheetId(
  storeName: string,
  configuredId = process.env.BUYBACK_SPREADSHEET_ID?.trim(),
  legacyManmanId = process.env.MANMAN_BUYBACK_SPREADSHEET_ID?.trim(),
): string {
  if (configuredId) return configuredId;
  if (storeName === DEFAULT_STORE_NAME) return legacyManmanId || DEFAULT_SPREADSHEET_ID;
  throw new Error(`${storeName}用のBUYBACK_SPREADSHEET_IDが未設定です`);
}

function franchiseRank(franchise: string): number {
  const rank = FRANCHISE_ORDER[franchise];
  if (rank === undefined) {
    throw new Error(`未対応の商材です: ${franchise}`);
  }
  return rank;
}

function assertNoDuplicateCardIds(ids: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(`生成ページに重複商品があります: ${[...duplicates].slice(0, 5).join(', ')}`);
  }
}

export function flattenGeneratedStorePageCardIds(pages: PublishPage[]): string[] {
  const storePages = pages.filter(page => page.kind === 'store');
  if (storePages.length === 0) {
    throw new Error('シート出力対象の店頭用生成ページがありません');
  }

  const incomplete = storePages.filter(page => page.status !== 'generated');
  if (incomplete.length > 0) {
    throw new Error(`未完了の店頭用ページが ${incomplete.length} 件あるため、シート更新を中止しました`);
  }

  const orderedIds = [...storePages]
    .sort((a, b) => {
      const franchiseDiff = franchiseRank(a.franchise) - franchiseRank(b.franchise);
      return franchiseDiff !== 0 ? franchiseDiff : a.page_index - b.page_index;
    })
    .flatMap(page => page.card_ids);

  if (orderedIds.length === 0) {
    throw new Error('生成ページにシート出力対象の商品がありません');
  }
  assertNoDuplicateCardIds(orderedIds);
  return orderedIds;
}

function effectiveImageUrl(card: PublishPreparedCard): string {
  if (card.image_status === 'fallback') {
    return card.alt_image_url ?? card.image_url ?? '';
  }
  if (card.image_status === 'dead') return '';
  return card.image_url ?? card.alt_image_url ?? '';
}

function effectiveRarity(
  item: PublishOrderListItem,
  card: PublishPreparedCard,
): string {
  const rarity = (item.rarity ?? card.rarity ?? '').trim();
  if (rarity !== "'-" && rarity !== '-') return rarity;

  const tag = card.tag?.trim() ?? '';
  return tag && !tag.includes('/') ? tag : rarity;
}

export function buildBuybackSheetValues(params: {
  runId: string;
  orderedCardIds: string[];
  cards: PublishPreparedCard[];
  orderListItems: PublishOrderListItem[];
  orderListImportId: string;
  businessDate: string;
}): SheetCell[][] {
  const cardById = new Map(params.cards.map(card => [card.id, card]));
  const itemById = new Map(params.orderListItems.map(item => [item.id, item]));

  const dataRows = params.orderedCardIds.flatMap((cardId): SheetCell[][] => {
    const card = cardById.get(cardId);
    if (!card) throw new Error(`prepared_card に出力対象商品がありません: ${cardId}`);
    if (card.run_id !== params.runId) {
      throw new Error(`別のRunに属する商品です: ${card.card_name} (${cardId})`);
    }
    if (!card.order_list_item_id) {
      throw new Error(`出力対象商品にオーダーリスト行がありません: ${card.card_name} (${cardId})`);
    }

    const item = itemById.get(card.order_list_item_id);
    if (!item) {
      throw new Error(`オーダーリスト行が見つかりません: ${card.order_list_item_id}`);
    }
    if (item.import_id !== params.orderListImportId) {
      throw new Error(`別のオーダーリストに属する商品です: ${item.excel_product_id}`);
    }
    if (item.franchise !== card.franchise) {
      throw new Error(`商材が一致しません: ${item.excel_product_id}`);
    }
    if (!item.excel_product_id.trim()) {
      throw new Error(`商品IDが空です: ${card.card_name}`);
    }
    if (isBoxRow(card) && card.price_high !== null && card.price_high <= 0) return [];
    if (card.price_high === null || card.price_high <= 0) {
      throw new Error(`買取価格が不正です: ${item.excel_product_id}`);
    }
    if (card.price_source_date !== params.businessDate) {
      throw new Error(`価格日とオーダーリスト業務日が一致しません: ${item.excel_product_id}`);
    }

    return [[
      item.excel_product_id,
      item.card_name || card.card_name,
      item.grade ?? card.grade ?? '',
      item.expansion ?? '',
      item.list_no ?? card.list_no ?? '',
      effectiveRarity(item, card),
      effectiveImageUrl(card),
      card.price_high,
      params.businessDate.replaceAll('-', '/'),
    ]];
  });

  return [[...BUYBACK_SHEET_HEADERS], ...dataRows];
}

async function fetchPreparedCards(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<PublishPreparedCard[]> {
  const rows: PublishPreparedCard[] = [];
  for (let i = 0; i < ids.length; i += QUERY_BATCH_SIZE) {
    const batch = ids.slice(i, i + QUERY_BATCH_SIZE);
    const { data, error } = await supabase
      .from('prepared_card')
      .select('id, run_id, order_list_item_id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, image_status, price_source_date')
      .in('id', batch)
      .returns<PublishPreparedCard[]>();
    if (error) throw new Error(`出力対象商品の取得に失敗しました: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

async function fetchOrderListItems(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<PublishOrderListItem[]> {
  const rows: PublishOrderListItem[] = [];
  for (let i = 0; i < ids.length; i += QUERY_BATCH_SIZE) {
    const batch = ids.slice(i, i + QUERY_BATCH_SIZE);
    const { data, error } = await supabase
      .from('order_list_item')
      .select('id, import_id, franchise, excel_product_id, card_name, grade, expansion, list_no, rarity')
      .in('id', batch)
      .returns<PublishOrderListItem[]>();
    if (error) throw new Error(`オーダーリスト行の取得に失敗しました: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

export async function publishManmanBuybackSheet(params: {
  supabase: SupabaseClient<Database>;
  runId: string;
  accessToken: string;
  boxPrices?: Map<string, number>;
  pricingSettings?: StorePricingSettings;
}): Promise<BuybackSheetPublishResult> {
  if (isBuybackSheetPublishDisabled()) {
    console.log('[buyback-sheet] publish explicitly disabled');
    return { status: 'skipped', rowCount: 0, contentHash: null, spreadsheetId: null };
  }

  const spreadsheetId = resolveBuybackSpreadsheetId(STORE_NAME);

  const findLatestCompletedRun = async () => params.supabase
    .from('run')
    .select('id')
    .eq('store', STORE_NAME)
    .eq('status', 'completed')
    .not('generate_done_at', 'is', null)
    .not('order_list_import_id', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle<Pick<Database['public']['Tables']['run']['Row'], 'id'>>();

  const { data: latestRun, error: latestRunError } = await findLatestCompletedRun();
  if (latestRunError) {
    throw new Error(`最新のMANMAN実行取得に失敗しました: ${latestRunError.message}`);
  }
  if (!latestRun) {
    throw new Error('公開可能な完了済みMANMAN実行がありません');
  }
  if (latestRun.id !== params.runId) {
    console.log(`[buyback-sheet] skipped historical run=${params.runId}; latest=${latestRun.id}`);
    return { status: 'skipped', rowCount: 0, contentHash: null, spreadsheetId };
  }

  const { data: run, error: runError } = await params.supabase
    .from('run')
    .select('id, store, order_list_import_id')
    .eq('id', params.runId)
    .eq('store', STORE_NAME)
    .eq('status', 'completed')
    .not('generate_done_at', 'is', null)
    .single<Pick<Database['public']['Tables']['run']['Row'], 'id' | 'store' | 'order_list_import_id'>>();
  if (runError || !run) {
    throw new Error(`MANMAN実行が見つかりません: ${runError?.message ?? params.runId}`);
  }
  if (!run.order_list_import_id) {
    throw new Error('実行にオーダーリスト取込IDがありません');
  }

  const { data: orderListImport, error: importError } = await params.supabase
    .from('order_list_import')
    .select('id, business_date, store')
    .eq('id', run.order_list_import_id)
    .eq('store', STORE_NAME)
    .single<Pick<Database['public']['Tables']['order_list_import']['Row'], 'id' | 'business_date' | 'store'>>();
  if (importError || !orderListImport) {
    throw new Error(`オーダーリスト取込が見つかりません: ${importError?.message ?? run.order_list_import_id}`);
  }

  const { data: pages, error: pageError } = await params.supabase
    .from('generated_page')
    .select('franchise, page_index, card_ids, status, kind')
    .eq('run_id', params.runId)
    .returns<PublishPage[]>();
  if (pageError) throw new Error(`生成ページの取得に失敗しました: ${pageError.message}`);

  const boxPrices = params.boxPrices ?? await loadShinsokuBoxPriceMap(params.accessToken);
  const pricingSettings = params.pricingSettings ?? await loadStorePricingSettings(params.supabase, STORE_NAME);
  const hasStorePages = (pages ?? []).some(page => page.kind === 'store');
  let orderedCardIds = hasStorePages ? flattenGeneratedStorePageCardIds(pages ?? []) : [];
  let storedCards = await fetchPreparedCards(params.supabase, orderedCardIds);
  if (!hasStorePages) {
    for (let offset = 0; ; offset += QUERY_BATCH_SIZE) {
      const { data, error } = await params.supabase.from('prepared_card').select('*')
        .eq('run_id', params.runId).order('id', { ascending: true })
        .range(offset, offset + QUERY_BATCH_SIZE - 1).returns<PreparedCardRow[]>();
      if (error) throw new Error(`出力対象商品の取得に失敗しました: ${error.message}`);
      storedCards.push(...(data ?? []));
      if ((data ?? []).length < QUERY_BATCH_SIZE) break;
    }
    orderedCardIds = storedCards.map(card => card.id);
  }
  const cards = applyCurrentShinsokuBoxPrices(storedCards, boxPrices, pricingSettings);
  // A valid source may exclude every BOX. Clear the sheet only when this is
  // proven, never merely because generation has not produced pages yet.
  if (!hasStorePages && (!cards.length || cards.some(card => !isBoxRow(card) || (card.price_high ?? 0) > 0))) {
    throw new Error('シート出力対象の店頭用生成ページがありません');
  }
  if (cards.length !== orderedCardIds.length) {
    throw new Error(`出力対象商品数が一致しません: expected=${orderedCardIds.length}, actual=${cards.length}`);
  }

  const itemIds = cards
    .map(card => card.order_list_item_id)
    .filter((id): id is string => Boolean(id));
  const orderListItems = await fetchOrderListItems(params.supabase, [...new Set(itemIds)]);
  const values = buildBuybackSheetValues({
    runId: params.runId,
    orderedCardIds,
    cards,
    orderListItems,
    orderListImportId: orderListImport.id,
    businessDate: orderListImport.business_date,
  });
  const contentHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');

  // データ収集中に新しいRunが完了していた場合、古いRunで上書きしない。
  const { data: latestRunBeforeWrite, error: latestRunBeforeWriteError } =
    await findLatestCompletedRun();
  if (latestRunBeforeWriteError) {
    throw new Error(`書き込み前の最新MANMAN実行確認に失敗しました: ${latestRunBeforeWriteError.message}`);
  }
  if (!latestRunBeforeWrite || latestRunBeforeWrite.id !== params.runId) {
    console.log(
      `[buyback-sheet] skipped stale write run=${params.runId}; latest=${latestRunBeforeWrite?.id ?? 'none'}`,
    );
    return { status: 'skipped', rowCount: 0, contentHash: null, spreadsheetId };
  }

  await replaceSheetValues({
    accessToken: params.accessToken,
    spreadsheetId,
    sheetId: TARGET_SHEET_ID,
    values,
    columnCount: BUYBACK_SHEET_HEADERS.length,
  });

  console.log(
    `[buyback-sheet] published: store=${STORE_NAME}, run=${params.runId}, rows=${values.length - 1}, hash=${contentHash}`,
  );
  return {
    status: 'completed',
    rowCount: values.length - 1,
    contentHash,
    spreadsheetId,
  };
}
