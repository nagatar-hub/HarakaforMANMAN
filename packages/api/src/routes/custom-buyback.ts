import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CUSTOM_BUYBACK_MAX_ITEMS,
  isCustomBuybackCatalogCard,
  planCustomBuybackPages,
  tokyoBusinessDate,
} from '@haraka/shared';
import type {
  CustomBuybackCatalogCard,
  CustomBuybackFranchise,
  CustomBuybackItemRow,
  CustomBuybackKind,
  CustomBuybackPageRow,
  CustomBuybackProductType,
  CustomBuybackSheetRow,
  Database,
  LayoutTemplateRow,
  OrderListImportRow,
  RunRow,
} from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { authorizeInternalApiRequest } from '../lib/internal-api-auth.js';
import { executeCloudRunJob } from '../lib/cloud-run-jobs.js';
import { isDefinitiveCloudRunJobRejection } from '../lib/cloud-run-errors.js';
import { STORE_NAME } from '../lib/store-scope.js';

const FRANCHISES = new Set<CustomBuybackFranchise>(['Pokemon', 'ONE PIECE', 'YU-GI-OH!']);
const PRODUCT_TYPES = new Set<CustomBuybackProductType>(['psa', 'box']);
const KINDS = new Set<CustomBuybackKind>(['postal', 'store']);
const CATALOG_LIMIT = 100;
const CATALOG_FETCH_LIMIT = 2500;
const GALLERY_PAGE_FETCH_LIMIT = 1000;
const CUSTOM_RENDER_JOB_NAME = process.env.CUSTOM_RENDER_JOB_NAME?.trim() || `haraka-${STORE_NAME}-custom-render`;

type DbClient = SupabaseClient<Database>;

type CustomBuybackGalleryPage = Pick<
  CustomBuybackPageRow,
  'id' | 'sheet_id' | 'page_index' | 'image_url' | 'status'
>;

type LatestPriceSnapshot = {
  runId: string;
  businessDate: string;
  isCurrent: boolean;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const customBuybackRoutes = new Hono();

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

customBuybackRoutes.use('*', async (c, next) => {
  const auth = authorizeInternalApiRequest(c.req.header('authorization'));
  if (auth === 'misconfigured') {
    return c.json({ error: 'カスタム買取表APIの認証設定がありません' }, 503);
  }
  if (auth !== 'authorized') return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

export function parseCustomBuybackCreate(body: unknown): ParseResult<{
  name: string;
  franchise: CustomBuybackFranchise;
  productType: CustomBuybackProductType;
  kind: CustomBuybackKind;
  displayDate: string;
}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '入力形式が正しくありません' };
  }
  const input = body as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const franchise = input.franchise;
  const productType = input.product_type;
  const kind = input.kind;
  const displayDate = input.display_date ?? tokyoBusinessDate();
  if (!name || name.length > 120) return { ok: false, error: '表名は1〜120文字で入力してください' };
  if (!FRANCHISES.has(franchise as CustomBuybackFranchise)) return { ok: false, error: 'カードタイトルが正しくありません' };
  if (!PRODUCT_TYPES.has(productType as CustomBuybackProductType)) return { ok: false, error: 'PSAまたはBOXを選択してください' };
  if (!KINDS.has(kind as CustomBuybackKind)) return { ok: false, error: '店頭用または郵送用を選択してください' };
  if (!isIsoCalendarDate(displayDate)) return { ok: false, error: '表の日付を正しく入力してください' };
  return {
    ok: true,
    value: {
      name,
      franchise: franchise as CustomBuybackFranchise,
      productType: productType as CustomBuybackProductType,
      kind: kind as CustomBuybackKind,
      displayDate,
    },
  };
}

export function parseCustomBuybackSheetPatch(body: unknown): ParseResult<{
  name?: string;
  displayDate?: string;
}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '入力形式が正しくありません' };
  }
  const input = body as Record<string, unknown>;
  const hasName = Object.hasOwn(input, 'name');
  const hasDisplayDate = Object.hasOwn(input, 'display_date');
  if (!hasName && !hasDisplayDate) return { ok: false, error: '変更内容がありません' };

  const value: { name?: string; displayDate?: string } = {};
  if (hasName) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) return { ok: false, error: '表名は1〜120文字で入力してください' };
    value.name = name;
  }
  if (hasDisplayDate) {
    if (!isIsoCalendarDate(input.display_date)) return { ok: false, error: '表の日付を正しく入力してください' };
    value.displayDate = input.display_date;
  }
  return { ok: true, value };
}

export function parseCustomBuybackPricePatch(body: unknown, productType: CustomBuybackProductType): ParseResult<{
  finalPriceHigh: number | null;
  finalPriceLow: number | null;
  overrideReason: string | null;
  reset: boolean;
}> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '入力形式が正しくありません' };
  }
  const input = body as Record<string, unknown>;
  if (input.reset === true) {
    return { ok: true, value: { finalPriceHigh: null, finalPriceLow: null, overrideReason: null, reset: true } };
  }
  const high = finitePrice(input.final_price_high);
  const low = productType === 'box' ? null : finitePrice(input.final_price_low);
  if (high == null || high <= 0) return { ok: false, error: '表示価格は1円以上で入力してください' };
  if (productType === 'psa' && (low == null || low <= 0)) {
    return { ok: false, error: 'PSAの下限価格は1円以上で入力してください' };
  }
  const reason = typeof input.override_reason === 'string' ? input.override_reason.trim() : '';
  if (reason.length > 240) return { ok: false, error: '修正理由は240文字以下にしてください' };
  return {
    ok: true,
    value: { finalPriceHigh: high, finalPriceLow: low, overrideReason: reason || null, reset: false },
  };
}

export function applyCustomBuybackBulkPrice(
  item: Pick<CustomBuybackItemRow, 'source_price_high' | 'source_price_low' | 'final_price_high' | 'final_price_low'>,
  operation: 'add' | 'percent' | 'round' | 'reset',
  value: number,
  productType: CustomBuybackProductType,
): { high: number | null; low: number | null } {
  if (operation === 'reset') return { high: item.source_price_high, low: productType === 'box' ? null : item.source_price_low };
  const transform = (current: number | null, source: number | null): number | null => {
    const base = current ?? source;
    if (base == null) return null;
    if (operation === 'add') return Math.max(1, Math.round(base + value));
    if (operation === 'percent') return Math.max(1, Math.round(base * (1 + value / 100)));
    const unit = Math.max(1, Math.round(Math.abs(value)));
    return Math.max(1, Math.round(base / unit) * unit);
  };
  return {
    high: transform(item.final_price_high, item.source_price_high),
    low: productType === 'box' ? null : transform(item.final_price_low, item.source_price_low),
  };
}

export function buildCustomBuybackCatalogOrFilter(query: string): string {
  const escaped = query.normalize('NFKC').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const pattern = `"%${escaped}%"`;
  return ['card_name', 'grade', 'list_no', 'rarity', 'tag', 'excel_product_id']
    .map((field) => `${field}.ilike.${pattern}`)
    .join(',');
}

export function matchCustomBuybackRefreshCards(
  items: Array<Pick<CustomBuybackItemRow, 'id' | 'source_db_card_id' | 'excel_product_id' | 'card_name' | 'grade' | 'list_no'>>,
  candidates: CustomBuybackCatalogCard[],
): { ok: true; itemIds: string[]; preparedCardIds: string[] } | { ok: false; unmatched: string[] } {
  const byExcel = new Map<string, CustomBuybackCatalogCard[]>();
  const byDb = new Map<string, CustomBuybackCatalogCard[]>();
  for (const card of candidates) {
    if (card.excel_product_id) byExcel.set(card.excel_product_id, [...(byExcel.get(card.excel_product_id) ?? []), card]);
    if (card.db_card_id) byDb.set(card.db_card_id, [...(byDb.get(card.db_card_id) ?? []), card]);
  }
  const normalized = (value: string | null) => (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ja-JP');
  const sameIdentity = (item: typeof items[number], card: CustomBuybackCatalogCard) =>
    normalized(item.card_name) === normalized(card.card_name)
    && normalized(item.grade) === normalized(card.grade)
    && normalized(item.list_no) === normalized(card.list_no);
  const used = new Set<string>();
  const preparedCardIds: string[] = [];
  const unmatched: string[] = [];
  for (const item of items) {
    const exactExcel = item.excel_product_id ? (byExcel.get(item.excel_product_id) ?? []) : [];
    const dbCandidates = item.source_db_card_id ? (byDb.get(item.source_db_card_id) ?? []) : [];
    const identityDb = dbCandidates.filter((card) => sameIdentity(item, card));
    const options = exactExcel.length === 1 ? exactExcel : identityDb.length === 1 ? identityDb : dbCandidates.length === 1 ? dbCandidates : [];
    const selected = options[0];
    if (!selected || used.has(selected.id)) {
      unmatched.push(item.card_name);
      continue;
    }
    used.add(selected.id);
    preparedCardIds.push(selected.id);
  }
  if (unmatched.length > 0 || preparedCardIds.length !== items.length) return { ok: false, unmatched };
  return { ok: true, itemIds: items.map((item) => item.id), preparedCardIds };
}

async function latestPriceSnapshot(supabase: DbClient): Promise<LatestPriceSnapshot | null> {
  const { data: sourceImport, error: importError } = await supabase
    .from('order_list_import')
    .select('*')
    .eq('store', STORE_NAME)
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<OrderListImportRow>();
  if (importError) throw new Error(`価格基準日取得失敗: ${importError.message}`);
  if (!sourceImport
    || sourceImport.status !== 'applied'
    || !sourceImport.structural_valid
    || !sourceImport.persistence_complete) return null;

  const { data: run, error: runError } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .eq('order_list_import_id', sourceImport.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle<RunRow>();
  if (runError) throw new Error(`最新Run取得失敗: ${runError.message}`);
  if (!run || run.status !== 'completed' || !run.completed_at) return null;
  return {
    runId: run.id,
    businessDate: sourceImport.business_date,
    isCurrent: sourceImport.business_date === tokyoBusinessDate(),
  };
}

async function ownedSheet(supabase: DbClient, sheetId: string): Promise<CustomBuybackSheetRow | null> {
  const { data, error } = await supabase
    .from('custom_buyback_sheet')
    .select('*')
    .eq('id', sheetId)
    .eq('store', STORE_NAME)
    .maybeSingle<CustomBuybackSheetRow>();
  if (error) throw new Error(`カスタム買取表取得失敗: ${error.message}`);
  return data;
}

async function sheetDetail(supabase: DbClient, sheet: CustomBuybackSheetRow) {
  const [itemsResult, pagesResult, layoutsResult] = await Promise.all([
    supabase.from('custom_buyback_item').select('*').eq('sheet_id', sheet.id).order('position').returns<CustomBuybackItemRow[]>(),
    supabase.from('custom_buyback_page').select('*').eq('sheet_id', sheet.id).order('page_index').returns<CustomBuybackPageRow[]>(),
    supabase.from('layout_template').select('*')
      .eq('store', STORE_NAME)
      .eq('franchise', sheet.franchise)
      .eq('kind', sheet.kind)
      .eq('is_active', true)
      .returns<LayoutTemplateRow[]>(),
  ]);
  if (itemsResult.error) throw new Error(`項目取得失敗: ${itemsResult.error.message}`);
  if (pagesResult.error) throw new Error(`生成ページ取得失敗: ${pagesResult.error.message}`);
  if (layoutsResult.error) throw new Error(`レイアウト取得失敗: ${layoutsResult.error.message}`);
  const items = itemsResult.data ?? [];
  const layouts = layoutsResult.data ?? [];
  const preview = planCustomBuybackPages(items.map((item) => item.id), layouts, sheet.product_type);
  return { sheet, items, pages: pagesResult.data ?? [], layouts, preview };
}

async function generatedGalleryPages(
  supabase: DbClient,
  sheetIds: string[],
): Promise<CustomBuybackGalleryPage[]> {
  const pages: CustomBuybackGalleryPage[] = [];
  for (let offset = 0; ; offset += GALLERY_PAGE_FETCH_LIMIT) {
    const { data, error } = await supabase.from('custom_buyback_page')
      .select('id, sheet_id, page_index, image_url, status')
      .in('sheet_id', sheetIds)
      .eq('status', 'generated')
      .not('image_url', 'is', null)
      .order('sheet_id')
      .order('page_index')
      .range(offset, offset + GALLERY_PAGE_FETCH_LIMIT - 1)
      .returns<CustomBuybackGalleryPage[]>();
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    pages.push(...batch);
    if (batch.length < GALLERY_PAGE_FETCH_LIMIT) return pages;
  }
}

function finitePrice(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) return null;
  return Math.round(value);
}

customBuybackRoutes.get('/custom-buyback/catalog', async (c) => {
  const franchise = c.req.query('franchise') as CustomBuybackFranchise | undefined;
  const productType = c.req.query('product_type') as CustomBuybackProductType | undefined;
  const queryText = (c.req.query('q') ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
  if (!franchise || !FRANCHISES.has(franchise)) return c.json({ error: 'カードタイトルが正しくありません' }, 400);
  if (!productType || !PRODUCT_TYPES.has(productType)) return c.json({ error: 'PSAまたはBOXを選択してください' }, 400);

  try {
    const supabase = createSupabaseClient();
    const snapshot = await latestPriceSnapshot(supabase);
    if (!snapshot) return c.json({ error: '利用できる完了済み価格データがありません' }, 503);

    let catalogQuery = supabase
      .from('prepared_card')
      .select('id, db_card_id, excel_product_id, franchise, card_name, grade, list_no, rarity, rarity_icon_url, tag, image_url, alt_image_url, image_status, price_high, price_low, price_source, price_source_date')
      .eq('run_id', snapshot.runId)
      .eq('franchise', franchise)
      .order('price_high', { ascending: false })
      .limit(CATALOG_FETCH_LIMIT);
    catalogQuery = productType === 'box'
      ? catalogQuery.eq('tag', 'BOX')
      : catalogQuery.ilike('grade', 'PSA%').or('tag.neq.BOX,tag.is.null');
    if (queryText) catalogQuery = catalogQuery.or(buildCustomBuybackCatalogOrFilter(queryText));
    const { data, error } = await catalogQuery.returns<CustomBuybackCatalogCard[]>();
    if (error) throw new Error(`カード検索失敗: ${error.message}`);

    const cards = (data ?? [])
      .filter((card) => card.price_source_date === snapshot.businessDate)
      .filter((card) => isCustomBuybackCatalogCard(card, productType))
      .filter((card) => {
        if (!queryText) return true;
        return [card.card_name, card.grade, card.list_no, card.rarity, card.tag, card.excel_product_id]
          .some((value) => value?.toLocaleLowerCase('ja-JP').includes(queryText));
      })
      .slice(0, CATALOG_LIMIT);
    return c.json({ snapshot, cards });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.get('/custom-buyback/sheets', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from('custom_buyback_sheet')
      .select('*')
      .eq('store', STORE_NAME)
      .order('updated_at', { ascending: false })
      .limit(100)
      .returns<CustomBuybackSheetRow[]>();
    if (error) throw new Error(error.message);
    return c.json(data ?? []);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.get('/custom-buyback/gallery', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const { data: sheets, error: sheetError } = await supabase
      .from('custom_buyback_sheet')
      .select('*')
      .eq('store', STORE_NAME)
      .order('display_date', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(200)
      .returns<CustomBuybackSheetRow[]>();
    if (sheetError) throw new Error(sheetError.message);
    if (!sheets?.length) return c.json([]);

    const sheetIds = sheets.map((sheet) => sheet.id);
    const pages = await generatedGalleryPages(supabase, sheetIds);

    const pagesBySheet = new Map<string, CustomBuybackGalleryPage[]>();
    for (const page of pages) {
      pagesBySheet.set(page.sheet_id, [...(pagesBySheet.get(page.sheet_id) ?? []), page]);
    }
    return c.json(sheets.map((sheet) => ({
      sheet,
      pages: pagesBySheet.get(sheet.id) ?? [],
    })));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'JSONが正しくありません' }, 400);
  }
  const parsed = parseCustomBuybackCreate(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  try {
    const supabase = createSupabaseClient();
    const snapshot = await latestPriceSnapshot(supabase);
    if (!snapshot) return c.json({ error: '利用できる完了済み価格データがありません' }, 503);
    if (!snapshot.isCurrent) {
      return c.json({
        error: `当日の価格データがありません。最新は${snapshot.businessDate}です。`,
        latest_business_date: snapshot.businessDate,
      }, 409);
    }
    const createdBy = c.req.header('x-haraka-operator-email')?.trim().toLowerCase() || null;
    const { data, error } = await supabase
      .from('custom_buyback_sheet')
      .insert({
        store: STORE_NAME,
        name: parsed.value.name,
        franchise: parsed.value.franchise,
        product_type: parsed.value.productType,
        kind: parsed.value.kind,
        price_snapshot_run_id: snapshot.runId,
        price_business_date: snapshot.businessDate,
        display_date: parsed.value.displayDate,
        created_by: createdBy,
      })
      .select('*')
      .single<CustomBuybackSheetRow>();
    if (error || !data) throw new Error(error?.message ?? '作成結果を取得できません');
    return c.json(data, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.get('/custom-buyback/sheets/:sheetId', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    return c.json(await sheetDetail(supabase, sheet));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.patch('/custom-buyback/sheets/:sheetId', async (c) => {
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'JSONが正しくありません' }, 400); }
  const parsed = parseCustomBuybackSheetPatch(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (parsed.value.displayDate && sheet.status === 'rendering') {
      return c.json({ error: '画像生成中は表の日付を変更できません' }, 409);
    }
    const updates: Database['public']['Tables']['custom_buyback_sheet']['Update'] = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.value.name) updates.name = parsed.value.name;
    if (parsed.value.displayDate) {
      updates.display_date = parsed.value.displayDate;
      updates.status = 'draft';
      updates.error_message = null;
    }
    const updateRequest = supabase
      .from('custom_buyback_sheet')
      .update(updates)
      .eq('id', c.req.param('sheetId'))
      .eq('store', STORE_NAME);
    const guardedRequest = parsed.value.displayDate
      ? updateRequest.neq('status', 'rendering')
      : updateRequest;
    const { data, error } = await guardedRequest
      .select('*')
      .maybeSingle<CustomBuybackSheetRow>();
    if (error) throw new Error(error.message);
    if (!data) return c.json({ error: '画像生成が開始されたため変更できません' }, 409);
    return c.json(data);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.delete('/custom-buyback/sheets/:sheetId', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中の表は削除できません' }, 409);
    const { data: deleted, error } = await supabase.from('custom_buyback_sheet').delete()
      .eq('id', sheet.id).eq('store', STORE_NAME).neq('status', 'rendering').select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!deleted) return c.json({ error: '画像生成が開始されたため削除できません' }, 409);
    return c.json({ status: 'deleted' });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets/:sheetId/items', async (c) => {
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'JSONが正しくありません' }, 400); }
  const rawIds = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).prepared_card_ids
    : null;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100 || rawIds.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'prepared_card_idsは1〜100件の配列にしてください' }, 400);
  }
  const preparedCardIds = [...new Set(rawIds as string[])];
  if (preparedCardIds.length !== rawIds.length) return c.json({ error: '同じカードが重複しています' }, 400);

  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中はカードを変更できません' }, 409);

    const { data: currentItems, error: currentError } = await supabase
      .from('custom_buyback_item')
      .select('*')
      .eq('sheet_id', sheet.id)
      .order('position')
      .returns<CustomBuybackItemRow[]>();
    if (currentError) throw new Error(currentError.message);
    if ((currentItems?.length ?? 0) + preparedCardIds.length > CUSTOM_BUYBACK_MAX_ITEMS) {
      return c.json({ error: `1つの表は最大${CUSTOM_BUYBACK_MAX_ITEMS}件です` }, 400);
    }

    const { data: cards, error: cardError } = await supabase
      .from('prepared_card')
      .select('id, db_card_id, excel_product_id, franchise, card_name, grade, list_no, rarity, rarity_icon_url, tag, image_url, alt_image_url, image_status, price_high, price_low, price_source, price_source_date')
      .eq('run_id', sheet.price_snapshot_run_id)
      .eq('franchise', sheet.franchise)
      .in('id', preparedCardIds)
      .returns<CustomBuybackCatalogCard[]>();
    if (cardError) throw new Error(cardError.message);
    if ((cards?.length ?? 0) !== preparedCardIds.length) {
      return c.json({ error: '選択カードに別Runまたは別タイトルの商品が含まれています' }, 400);
    }
    const cardById = new Map((cards ?? []).map((card) => [card.id, card]));
    const orderedCards = preparedCardIds.map((id) => cardById.get(id)!);
    if (orderedCards.some((card) => card.price_source_date !== sheet.price_business_date)) {
      return c.json({ error: '価格基準日が表のスナップショットと一致しない商品があります' }, 409);
    }
    if (orderedCards.some((card) => !isCustomBuybackCatalogCard(card, sheet.product_type))) {
      return c.json({ error: `${sheet.product_type === 'box' ? 'BOX' : 'PSA'}の掲載条件または価格条件を満たさない商品があります` }, 400);
    }
    const existingSourceIds = new Set((currentItems ?? []).map((item) => item.source_prepared_card_id).filter(Boolean));
    if (orderedCards.some((card) => existingSourceIds.has(card.id))) {
      return c.json({ error: 'すでに追加済みのカードが含まれています' }, 409);
    }
    const { error: insertError } = await supabase.rpc('add_custom_buyback_items', {
      p_sheet_id: sheet.id,
      p_store: STORE_NAME,
      p_prepared_card_ids: orderedCards.map((card) => card.id),
    });
    if (insertError) {
      if (insertError.code === '23505') return c.json({ error: 'すでに追加済みのカードがあります' }, 409);
      throw new Error(insertError.message);
    }
    const { data: inserted, error: readError } = await supabase.from('custom_buyback_item').select('*')
      .eq('sheet_id', sheet.id).in('source_prepared_card_id', preparedCardIds).returns<CustomBuybackItemRow[]>();
    if (readError) throw new Error(readError.message);
    return c.json({ added: inserted ?? [], total: (currentItems?.length ?? 0) + (inserted?.length ?? 0) }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.patch('/custom-buyback/sheets/:sheetId/items/:itemId', async (c) => {
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'JSONが正しくありません' }, 400); }
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中は価格を変更できません' }, 409);
    const parsed = parseCustomBuybackPricePatch(body, sheet.product_type);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const { data: item, error: itemError } = await supabase
      .from('custom_buyback_item')
      .select('*')
      .eq('id', c.req.param('itemId'))
      .eq('sheet_id', sheet.id)
      .maybeSingle<CustomBuybackItemRow>();
    if (itemError) throw new Error(itemError.message);
    if (!item) return c.json({ error: 'カードが見つかりません' }, 404);
    const values = parsed.value.reset
      ? {
          final_price_high: item.source_price_high,
          final_price_low: sheet.product_type === 'box' ? null : item.source_price_low,
          override_reason: null,
        }
      : {
          final_price_high: parsed.value.finalPriceHigh,
          final_price_low: parsed.value.finalPriceLow,
          override_reason: parsed.value.overrideReason,
        };
    const { data: updated, error: updateError } = await supabase
      .from('custom_buyback_item')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq('id', item.id)
      .eq('sheet_id', sheet.id)
      .select('*')
      .single<CustomBuybackItemRow>();
    if (updateError) throw new Error(updateError.message);
    await supabase.from('custom_buyback_sheet').update({
      status: 'draft', error_message: null, updated_at: new Date().toISOString(),
    }).eq('id', sheet.id).eq('store', STORE_NAME);
    return c.json(updated);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.delete('/custom-buyback/sheets/:sheetId/items/:itemId', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中はカードを変更できません' }, 409);
    const { error } = await supabase.rpc('delete_custom_buyback_item', {
      p_sheet_id: sheet.id, p_store: STORE_NAME, p_item_id: c.req.param('itemId'),
    });
    if (error) {
      if (error.code === 'P0002') return c.json({ error: 'カードが見つかりません' }, 404);
      throw new Error(error.message);
    }
    const { data: remaining, error: remainingError } = await supabase
      .from('custom_buyback_item').select('id').eq('sheet_id', sheet.id).order('position');
    if (remainingError) throw new Error(remainingError.message);
    return c.json({ status: 'deleted', total: remaining?.length ?? 0 });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.put('/custom-buyback/sheets/:sheetId/reorder', async (c) => {
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'JSONが正しくありません' }, 400); }
  const itemIds = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).item_ids
    : null;
  if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== 'string')) {
    return c.json({ error: 'item_ids配列が必要です' }, 400);
  }
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中は並べ替えできません' }, 409);
    const { error } = await supabase.rpc('reorder_custom_buyback_items', {
      p_sheet_id: sheet.id,
      p_store: STORE_NAME,
      p_item_ids: itemIds as string[],
    });
    if (error) return c.json({ error: '並び順に別表のカード・重複・不足があります' }, 400);
    return c.json({ status: 'ok', item_ids: itemIds });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets/:sheetId/bulk-price', async (c) => {
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'JSONが正しくありません' }, 400); }
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const itemIds = Array.isArray(input.item_ids) && input.item_ids.every((id) => typeof id === 'string')
    ? input.item_ids as string[]
    : [];
  const operation = input.operation;
  const value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : 0;
  if (itemIds.length === 0 || itemIds.length > CUSTOM_BUYBACK_MAX_ITEMS || new Set(itemIds).size !== itemIds.length) {
    return c.json({ error: '重複のないitem_idsを1件以上指定してください' }, 400);
  }
  if (!['add', 'percent', 'round', 'reset'].includes(String(operation))) {
    return c.json({ error: '価格操作が正しくありません' }, 400);
  }
  if (operation === 'round' && value <= 0) return c.json({ error: '丸め単位は1円以上にしてください' }, 400);
  if (Math.abs(value) > 1_000_000) return c.json({ error: '調整値が大きすぎます' }, 400);
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中は価格を変更できません' }, 409);
    const { error } = await supabase.rpc('bulk_update_custom_buyback_prices', {
      p_sheet_id: sheet.id,
      p_store: STORE_NAME,
      p_item_ids: itemIds,
      p_operation: operation as 'add' | 'percent' | 'round' | 'reset',
      p_value: value,
    });
    if (error) return c.json({ error: '価格調整対象に別表のカードが含まれています' }, 400);
    return c.json({ status: 'ok', updated: itemIds.length });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets/:sheetId/clone', async (c) => {
  let body: unknown = {};
  try { body = await c.req.json<unknown>(); } catch { /* an empty body uses the default name */ }
  const requestedName = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).name
    : null;
  try {
    const supabase = createSupabaseClient();
    const source = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!source) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    const name = typeof requestedName === 'string' ? requestedName.trim() : `${source.name} のコピー`;
    if (!name || name.length > 120) return c.json({ error: '表名は1〜120文字で入力してください' }, 400);
    const createdBy = c.req.header('x-haraka-operator-email')?.trim().toLowerCase() || null;
    const { data: newSheetId, error } = await supabase.rpc('clone_custom_buyback_sheet', {
      p_sheet_id: source.id,
      p_store: STORE_NAME,
      p_name: name,
      p_created_by: createdBy,
    });
    if (error || !newSheetId) throw new Error(error?.message ?? '複製結果を取得できません');
    const cloned = await ownedSheet(supabase, newSheetId);
    if (!cloned) throw new Error('複製した表を取得できません');
    return c.json(await sheetDetail(supabase, cloned), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets/:sheetId/refresh-prices', async (c) => {
  let body: unknown = {};
  try { body = await c.req.json<unknown>(); } catch { /* defaults preserve manual overrides */ }
  const preserveOverrides = !(body && typeof body === 'object' && !Array.isArray(body)
    && (body as Record<string, unknown>).preserve_overrides === false);
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: '画像生成中は価格を更新できません' }, 409);
    const snapshot = await latestPriceSnapshot(supabase);
    if (!snapshot) return c.json({ error: '利用できる完了済み価格データがありません' }, 503);
    if (!snapshot.isCurrent) {
      return c.json({ error: `当日の価格データがありません。最新は${snapshot.businessDate}です。` }, 409);
    }
    const { data: items, error: itemError } = await supabase.from('custom_buyback_item')
      .select('*').eq('sheet_id', sheet.id).order('position').returns<CustomBuybackItemRow[]>();
    if (itemError) throw new Error(itemError.message);
    const currentItems = items ?? [];
    if (currentItems.length === 0) {
      return c.json({ error: '価格更新するカードがありません' }, 400);
    }

    const dbIds = [...new Set(currentItems.map((item) => item.source_db_card_id).filter((id): id is string => Boolean(id)))];
    const excelIds = [...new Set(currentItems.map((item) => item.excel_product_id).filter((id): id is string => Boolean(id)))];
    const candidateById = new Map<string, CustomBuybackCatalogCard>();
    const select = 'id, db_card_id, excel_product_id, franchise, card_name, grade, list_no, rarity, rarity_icon_url, tag, image_url, alt_image_url, image_status, price_high, price_low, price_source, price_source_date';
    for (let offset = 0; offset < Math.max(dbIds.length, excelIds.length); offset += 100) {
      const queries = [];
      const dbChunk = dbIds.slice(offset, offset + 100);
      const excelChunk = excelIds.slice(offset, offset + 100);
      if (dbChunk.length > 0) queries.push(supabase.from('prepared_card').select(select)
        .eq('run_id', snapshot.runId).eq('franchise', sheet.franchise).in('db_card_id', dbChunk).returns<CustomBuybackCatalogCard[]>());
      if (excelChunk.length > 0) queries.push(supabase.from('prepared_card').select(select)
        .eq('run_id', snapshot.runId).eq('franchise', sheet.franchise).in('excel_product_id', excelChunk).returns<CustomBuybackCatalogCard[]>());
      const results = await Promise.all(queries);
      for (const result of results) {
        if (result.error) throw new Error(`当日価格候補取得失敗: ${result.error.message}`);
        for (const card of result.data ?? []) {
          if (card.price_source_date === snapshot.businessDate && isCustomBuybackCatalogCard(card, sheet.product_type)) {
            candidateById.set(card.id, card);
          }
        }
      }
    }
    const matched = matchCustomBuybackRefreshCards(currentItems, [...candidateById.values()]);
    if (!matched.ok) {
      return c.json({
        error: '当日データで一意に照合できないカードがあります。表は変更していません。',
        unmatched: matched.unmatched.slice(0, 20),
      }, 409);
    }
    const { error: refreshError } = await supabase.rpc('refresh_custom_buyback_prices', {
      p_sheet_id: sheet.id,
      p_store: STORE_NAME,
      p_run_id: snapshot.runId,
      p_business_date: snapshot.businessDate,
      p_item_ids: matched.itemIds,
      p_prepared_card_ids: matched.preparedCardIds,
      p_preserve_overrides: preserveOverrides,
    });
    if (refreshError) return c.json({ error: '価格更新を完了できませんでした。表は変更していません。' }, 409);
    const refreshed = await ownedSheet(supabase, sheet.id);
    if (!refreshed) throw new Error('更新した表を取得できません');
    return c.json(await sheetDetail(supabase, refreshed));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

customBuybackRoutes.post('/custom-buyback/sheets/:sheetId/render', async (c) => {
  try {
    const supabase = createSupabaseClient();
    const sheet = await ownedSheet(supabase, c.req.param('sheetId'));
    if (!sheet) return c.json({ error: 'カスタム買取表が見つかりません' }, 404);
    if (sheet.status === 'rendering') return c.json({ error: 'すでに画像生成中です' }, 409);
    const detail = await sheetDetail(supabase, sheet);
    if (detail.items.length === 0) return c.json({ error: 'カードを1件以上追加してください' }, 400);
    if (!detail.preview || detail.preview.length === 0) return c.json({ error: '利用できるレイアウトがありません' }, 409);
    const priceInvalid = detail.items.some((item) =>
      !item.final_price_high || (sheet.product_type === 'psa' && !item.final_price_low),
    );
    if (priceInvalid) return c.json({ error: '表示価格が未設定のカードがあります' }, 400);

    const revision = sheet.revision + 1;
    const { data: claimed, error: claimError } = await supabase
      .from('custom_buyback_sheet')
      .update({
        status: 'rendering',
        revision,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sheet.id)
      .eq('store', STORE_NAME)
      .eq('revision', sheet.revision)
      .neq('status', 'rendering')
      .select('id')
      .maybeSingle();
    if (claimError) throw new Error(`生成開始状態の保存失敗: ${claimError.message}`);
    if (!claimed) return c.json({ error: '別の操作が先に表を更新しました。再読み込みしてください。' }, 409);

    try {
      const execution = await executeCloudRunJob(CUSTOM_RENDER_JOB_NAME, {
        env: {
          JOB_NAME: 'render-custom-buyback',
          CUSTOM_BUYBACK_SHEET_ID: sheet.id,
          CUSTOM_BUYBACK_REVISION: String(revision),
          TRIGGER: 'web-ui',
        },
      });
      return c.json({ status: 'rendering', revision, ...execution }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitiveCloudRunJobRejection(error)) {
        await supabase.from('custom_buyback_sheet').update({
          status: 'failed',
          error_message: `レンダーJob起動失敗: ${message}`,
          updated_at: new Date().toISOString(),
        }).eq('id', sheet.id).eq('store', STORE_NAME).eq('revision', revision);
        return c.json({ error: `レンダーJobを起動できません: ${message}` }, 503);
      }
      await supabase.from('custom_buyback_sheet').update({
        error_message: `Job起動結果を確認できません: ${message}`,
        updated_at: new Date().toISOString(),
      }).eq('id', sheet.id).eq('store', STORE_NAME).eq('revision', revision);
      return c.json({
        status: 'rendering',
        revision,
        launch_status: 'unknown',
        warning: 'Job起動結果が不明なため二重起動を避けて状態確認を待ちます',
      }, 202);
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
