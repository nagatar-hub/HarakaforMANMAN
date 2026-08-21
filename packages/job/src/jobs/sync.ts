/**
 * Sync ジョブ — データ取込からページプランニングまでの統合パイプライン
 *
 * 処理フロー:
 * 1.  確認済みオーダーリスト取込を処理中へ確保
 * 2.  Run レコード作成
 * 3.  Haraka DB 用 OAuth credentials 取得
 * 4.  照合済み Excel 行を raw_import 保存
 * 5.  Haraka DB スプレッドシートの DB タブを db_card へ同期
 * 6.  永続商品対応で PreparedCard 変換 → prepared_card 保存
 * 7.  Spectre 取込・重複排除・当日リストとの交差処理
 * 8.  画像ヘルスチェック → image_status 更新
 * 9.  タグなしカード集計
 * 10. ページプランニング → generated_page 保存
 */

import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { batchInsert, batchUpsert } from '../lib/batch.js';
import { buildDbCardRows } from '../lib/db-card-sync.js';
import { prepareOrderListCards } from '../lib/prepare-order-list.js';
import {
  applyPokemonBoxPriceOverrides,
  parsePokemonBoxPriceRows,
} from '../lib/pokemon-box-price-source.js';
import { parseSpectreRows, spectreIntersectionKey } from '../lib/spectre-parser.js';
import { deduplicateByListNo } from '../lib/dedup.js';
import { checkImageHealth } from '../lib/image-health-check.js';
import { updateProgress, clearProgress } from '../lib/progress.js';
import { planPages } from '../lib/page-planner.js';
import { sendDiscordNotification, COLOR } from '../lib/discord.js';
import { OAuthInvalidGrantError } from '../lib/fetch-with-retry.js';
import { startOrderListLease } from '../lib/order-list-lease.js';
import { getOptionalEnvOrSecret, getRequiredEnvOrSecret } from '../lib/env.js';
import { loadStorePricingSettings } from '../lib/pricing-settings.js';
import type {
  Database,
  PreparedCardRow,
  AssetProfileRow,
  RuleRow,
  StorePricingSettings,
} from '@haraka/shared';
import { FRANCHISES, isBuiltInOrderListExclusion } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];
type OrderListImportRow = Database['public']['Tables']['order_list_import']['Row'];
type OrderListItemRow = Database['public']['Tables']['order_list_item']['Row'];
type DbCardRow = Database['public']['Tables']['db_card']['Row'];
type GeneratedPageInsert = Database['public']['Tables']['generated_page']['Insert'];
type RunUpdate = Database['public']['Tables']['run']['Update'];

const PAGE_SIZE = 1000;
const DB_CARD_QUERY_BATCH_SIZE = 200;
const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_POKEMON_BOX_SPREADSHEET_ID = '1xxIJ0Rbi90I_Bd2FhGVcu3cdlAcVAxl0x6wk5913vWw';
const POKEMON_BOX_PRICE_RANGE = 'Database';

type Supabase = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;
function createOrderListLease(supabase: Supabase, importId: string, runId: string) {
  return startOrderListLease({
    renew: async (id, heartbeatAt) => {
      const { data, error } = await supabase.rpc('renew_order_list_sync_lease', {
        p_import_id: id,
        p_run_id: runId,
        p_heartbeat_at: heartbeatAt,
      });
      if (error || data !== true) {
        throw new Error(error?.message ?? 'processing import or run is no longer active');
      }
    },
  }, importId);
}

async function updateRunningRun(
  supabase: Supabase,
  runId: string,
  values: RunUpdate,
  context: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('run')
    .update(values)
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error || !data) {
    throw new Error(`${context}: ${error?.message ?? 'run is no longer running'}`);
  }
}


/** Supabase の API 上限を越えるオーダーリストでも全件を確実に取得する。 */
export async function fetchAllMatchedOrderListItems(
  supabase: Supabase,
  importId: string,
): Promise<OrderListItemRow[]> {
  const items: OrderListItemRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('order_list_item')
      .select('*')
      .eq('import_id', importId)
      .eq('match_status', 'matched')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<OrderListItemRow[]>();
    if (error) throw new Error(`order_list_item 取得失敗: ${error.message}`);

    const page = data ?? [];
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return items;
}

/** 取込行を監査可能な raw_import 形式に変換する。 */
export function buildOrderListRawImports(
  items: OrderListItemRow[],
  runId: string,
): RawImportInsert[] {
  return items.map((item) => ({
    run_id: runId,
    order_list_item_id: item.id,
    excel_product_id: item.excel_product_id,
    db_card_id: item.db_card_id,
    franchise: item.franchise,
    card_name: item.card_name,
    grade: item.grade,
    list_no: item.list_no,
    image_url: item.image_url,
    rarity: item.rarity,
    demand: item.demand,
    kecak_price: null,
    source_price: item.source_price,
    price_source: 'order_list',
    raw_row: item.raw_row,
  }));
}

/**
 * 旧バージョンで matched になった組み込み除外行を、
 * 監査データは残したまま公開準備対象から除く。
 */
export function filterPublishableOrderListRows<T extends { card_name: string | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => !isBuiltInOrderListExclusion(row.card_name));
}

/**
 * Sync本体が prepared_card へ保存する最終対象だけを変換する。
 *
 * raw_import はこの関数より前に全件保存されるため、除外した旧matched行も監査に残る。
 */
export function preparePublishableOrderListCards(
  rawImports: RawImportRow[],
  dbCardsById: Map<string, DbCardRow>,
  businessDate: string,
  pricingSettings: StorePricingSettings,
): ReturnType<typeof prepareOrderListCards> {
  return prepareOrderListCards(
    filterPublishableOrderListRows(rawImports),
    dbCardsById,
    businessDate,
    pricingSettings,
  );
}

async function fetchAllRunRawImports(
  supabase: Supabase,
  runId: string,
): Promise<RawImportRow[]> {
  const rows: RawImportRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('raw_import')
      .select('*')
      .eq('run_id', runId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<RawImportRow[]>();
    if (error) throw new Error(`raw_import 取得失敗: ${error.message}`);

    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchAllRunPreparedCards(
  supabase: Supabase,
  runId: string,
): Promise<PreparedCardRow[]> {
  const rows: PreparedCardRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('prepared_card')
      .select('*')
      .eq('run_id', runId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<PreparedCardRow[]>();
    if (error) throw new Error(`prepared_card 取得失敗: ${error.message}`);

    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchMappedDbCards(
  supabase: Supabase,
  items: OrderListItemRow[],
): Promise<Map<string, DbCardRow>> {
  const missingMapping = items.filter((item) => !item.db_card_id);
  if (missingMapping.length > 0) {
    const examples = missingMapping.slice(0, 5).map((item) => item.excel_product_id).join(', ');
    throw new Error(`照合済み行のDB商品IDがありません: ${missingMapping.length}件 (${examples})`);
  }

  const ids = [...new Set(items.map((item) => item.db_card_id as string))];
  const dbCardsById = new Map<string, DbCardRow>();

  for (let i = 0; i < ids.length; i += DB_CARD_QUERY_BATCH_SIZE) {
    const batch = ids.slice(i, i + DB_CARD_QUERY_BATCH_SIZE);
    const { data, error } = await supabase
      .from('db_card')
      .select('*')
      .eq('store', STORE_NAME)
      .in('id', batch)
      .returns<DbCardRow[]>();
    if (error) throw new Error(`db_card 取得失敗: ${error.message}`);
    for (const dbCard of data ?? []) dbCardsById.set(dbCard.id, dbCard);
  }

  const missingIds = ids.filter((id) => !dbCardsById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`対応先DB商品が見つかりません: ${missingIds.length}件 (${missingIds.slice(0, 5).join(', ')})`);
  }

  return dbCardsById;
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

export async function runSync(): Promise<void> {
  const orderListImportId = process.env.ORDER_LIST_IMPORT_ID?.trim();
  const orderListSyncRequestId = process.env.ORDER_LIST_SYNC_REQUEST_ID?.trim() || null;
  const orderListSyncRequestFingerprint = process.env.ORDER_LIST_SYNC_REQUEST_FINGERPRINT?.trim() || null;
  if (!orderListImportId) {
    throw new Error('ORDER_LIST_IMPORT_ID is required');
  }
  if (Boolean(orderListSyncRequestId) !== Boolean(orderListSyncRequestFingerprint)) {
    throw new Error('ORDER_LIST_SYNC_REQUEST_ID and ORDER_LIST_SYNC_REQUEST_FINGERPRINT must be provided together');
  }
  if (orderListSyncRequestId && !UUID_PATTERN.test(orderListSyncRequestId)) {
    throw new Error('ORDER_LIST_SYNC_REQUEST_ID must be a UUID');
  }
  if (orderListSyncRequestFingerprint && !SHA256_PATTERN.test(orderListSyncRequestFingerprint)) {
    throw new Error('ORDER_LIST_SYNC_REQUEST_FINGERPRINT must be a SHA-256 hex digest');
  }

  const t0 = Date.now();
  const supabase = await createSupabaseClientFromSecrets();

  // ---- 1. 確認済み取込を処理中へ確保（同一取込の二重実行を防ぐ） ----
  const processingStartedAt = new Date().toISOString();
  const claimBase = supabase
    .from('order_list_import')
    .update({
      status: 'processing',
      processing_started_at: processingStartedAt,
      heartbeat_at: processingStartedAt,
      failed_at: null,
      failure_message: null,
    })
    .eq('id', orderListImportId)
    .eq('store', STORE_NAME)
    .eq('status', 'confirmed');
  const claimQuery = orderListSyncRequestId && orderListSyncRequestFingerprint
    ? claimBase
      .eq('order_list_sync_request_id', orderListSyncRequestId)
      .eq('order_list_sync_request_fingerprint', orderListSyncRequestFingerprint)
    : claimBase
      .is('order_list_sync_request_id', null)
      .is('order_list_sync_request_fingerprint', null);
  const { data: orderListImport, error: claimError } = await claimQuery
    .select('*')
    .single<OrderListImportRow>();
  if (claimError || !orderListImport) {
    throw new Error(`確認済みオーダーリスト取込を確保できません (${orderListImportId}): ${claimError?.message ?? 'status is not confirmed'}`);
  }

  // ---- 2. Run レコード作成 ----
  const { data: run, error: runError } = await supabase
    .from('run')
    .insert({
      triggered_by: process.env.TRIGGER || 'manual',
      order_list_import_id: orderListImport.id,
      order_list_sync_request_id: orderListSyncRequestId,
      order_list_sync_request_fingerprint: orderListSyncRequestFingerprint,
      store: STORE_NAME,
    })
    .select()
    .single<RunRow>();
  if (runError || !run) {
    const message = `Run作成失敗: ${runError?.message ?? 'unknown error'}`;
    const failedAt = new Date().toISOString();
    const { data: failedImport, error: stateError } = await supabase
      .from('order_list_import')
      .update({
        status: 'failed',
        failed_at: failedAt,
        failure_message: message,
        heartbeat_at: null,
        updated_at: failedAt,
      })
      .eq('id', orderListImport.id)
      .eq('store', STORE_NAME)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle();
    if (stateError || !failedImport) {
      throw new Error(`${message}; 取込失敗状態の保存にも失敗: ${stateError?.message ?? 'state changed'}`);
    }
    throw new Error(message);
  }
  console.log(`[sync] Run 作成: ${run.id} / order_list_import=${orderListImport.id}`);

  const lease = createOrderListLease(supabase, orderListImport.id, run.id);
  try {
    await lease.renewNow();
    // ---- 3. Haraka DB 用 OAuth access token 取得 ----
    await updateProgress(supabase, run.id, 0, 100, '認証中...');
    const accessToken = await getAccessToken();
    const harakaDbSpreadsheetId = await getRequiredEnvOrSecret('HARAKA_DB_SPREADSHEET_ID');
    const pokemonBoxSpreadsheetId =
      (await getOptionalEnvOrSecret('POKEMON_BOX_SPREADSHEET_ID')) ?? DEFAULT_POKEMON_BOX_SPREADSHEET_ID;
    console.log('[sync] Access token 取得完了（Haraka DB）');

    console.log('[sync] Pokemon BOX価格DB 取得: Database');
    const pokemonBoxPriceRows = await fetchSheetValues({
      accessToken,
      spreadsheetId: pokemonBoxSpreadsheetId,
      range: POKEMON_BOX_PRICE_RANGE,
    });
    const pokemonBoxPriceMap = parsePokemonBoxPriceRows(pokemonBoxPriceRows);
    console.log(`[sync] Pokemon BOX価格DB: ${pokemonBoxPriceMap.size}件`);

    // ---- 4. 照合済みオーダーリスト行 → raw_import ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 5, 100, 'オーダーリスト取込中...');
    const orderListItems = await fetchAllMatchedOrderListItems(supabase, orderListImport.id);
    if (orderListItems.length === 0) {
      throw new Error('照合済みのオーダーリスト行がありません');
    }
    const boxPriceResult = applyPokemonBoxPriceOverrides(
      buildOrderListRawImports(orderListItems, run.id),
      pokemonBoxPriceMap,
    );
    const rawImportInserts = boxPriceResult.rows;
    if (boxPriceResult.missingNames.length > 0) {
      const sample = boxPriceResult.missingNames.slice(0, 10).join(', ');
      console.warn(`[sync] Pokemon BOX価格DB 未マッチ: ${boxPriceResult.missingNames.length}件（オーダーリストはExcel価格を使用） (${sample})`);
    }
    await batchInsert(supabase, 'raw_import', rawImportInserts as unknown as Record<string, unknown>[]);
    const allRawImports = await fetchAllRunRawImports(supabase, run.id);
    const totalImported = allRawImports.length;

    await updateRunningRun(
      supabase,
      run.id,
      { total_imported: totalImported, import_done_at: new Date().toISOString() },
      'Run取込監査更新失敗',
    );
    console.log(`[sync] インポート完了: 合計 ${totalImported}件`);

    // ---- 5. Haraka DB シート → db_card 同期 ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 20, 100, 'Haraka DB 同期中...');
    console.log('[sync] Haraka DB 取得: DBタブ');
    const allDbRows = await fetchSheetValues({
      accessToken,
      spreadsheetId: harakaDbSpreadsheetId,
      range: 'DB',
    });

    const dbDataRows = allDbRows.slice(1);
    const dbCardRows = buildDbCardRows(dbDataRows).map((row) => ({
      ...row,
      store: STORE_NAME,
    }));
    if (dbCardRows.length > 0) {
      await batchUpsert(
        supabase,
        'db_card',
        dbCardRows as unknown as Record<string, unknown>[],
        'store,franchise,card_name,grade,list_no',
      );
      console.log(`[sync] db_card upsert 完了: ${dbCardRows.length}件`);
    }

    // ---- 5.5. MANMANのstore_configから価格設定を取得 ----
    const pricingSettings = await loadStorePricingSettings(supabase, STORE_NAME);
    const boxRateSummary = FRANCHISES
      .map((franchise) => {
        const rates = pricingSettings.box_discount_rates[franchise];
        return `${franchise}=有${(rates.shrink * 100).toFixed(0)}%/無${(rates.no_shrink * 100).toFixed(0)}%`;
      })
      .join(', ');
    console.log(`[sync] BOX割引率: ${boxRateSummary}`);
    const psaRateSummary = FRANCHISES
      .map((franchise) => `${franchise}=${(pricingSettings.psa10_discount_rates[franchise] * 100).toFixed(0)}%`)
      .join(', ');
    console.log(`[sync] 商材別減額率: ${psaRateSummary}`);

    // ---- 6. PreparedCard 変換 + 保存（Excel ID の永続対応先だけを使用） ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 30, 100, 'PreparedCard 変換中...');
    const publishableOrderListItems = filterPublishableOrderListRows(orderListItems);
    const publishableRawImports = filterPublishableOrderListRows(allRawImports);
    const builtInExcludedCount = allRawImports.length - publishableRawImports.length;
    if (builtInExcludedCount > 0) {
      console.warn(`[sync] 組み込み除外行: ${builtInExcludedCount}件（raw_import監査には保持）`);
    }
    const dbCardsById = await fetchMappedDbCards(supabase, publishableOrderListItems);
    const prepared = preparePublishableOrderListCards(
      allRawImports,
      dbCardsById,
      orderListImport.business_date,
      pricingSettings,
    );
    if (prepared.length !== publishableRawImports.length) {
      throw new Error(`PreparedCard変換件数が一致しません: publishable=${publishableRawImports.length}, prepared=${prepared.length}`);
    }
    await batchInsert(supabase, 'prepared_card', prepared as unknown as Record<string, unknown>[]);
    let totalPrepared = prepared.length;

    await updateRunningRun(
      supabase,
      run.id,
      { total_prepared: totalPrepared, prepare_done_at: new Date().toISOString() },
      'PreparedCard監査更新失敗',
    );
    console.log(`[sync] 準備完了: ${totalPrepared}件`);

    // ---- 6. Spectre 取込 ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 40, 100, 'Spectre 取込中...');
    console.log('[sync] SpectreMapping 取得中...');
    // Spectre の franchise|list_no|grade → tag マップ（交差処理で使用）
    const spectreTagMap = new Map<string, string>();
    let spectreCards: ReturnType<typeof parseSpectreRows> = [];
    try {
      const spectreRows = await fetchSheetValues({
        accessToken,
        spreadsheetId: harakaDbSpreadsheetId,
        range: 'SpectreMapping',
      });

      if (spectreRows.length > 1) {
        spectreCards = parseSpectreRows(
          spectreRows,
          'Pokemon',
          run.id,
          pricingSettings.psa10_discount_rates,
        );
        // 交差処理用に franchise|list_no|grade → tag を記録
        for (const sc of spectreCards) {
          if (sc.list_no && sc.tag) {
            spectreTagMap.set(spectreIntersectionKey(sc.franchise, sc.list_no, sc.grade), sc.tag);
          }
        }
      }
    } catch (spectreErr) {
      console.log(`[sync] SpectreMapping スキップ: ${spectreErr instanceof Error ? spectreErr.message : String(spectreErr)}`);
    }

    // シート取得は任意だが、取得後のDB保存失敗は同期失敗として扱う。
    if (spectreCards.length > 0) {
      await batchInsert(supabase, 'prepared_card', spectreCards as unknown as Record<string, unknown>[]);
      totalPrepared += spectreCards.length;
      console.log(`[sync] Spectre カード: ${spectreCards.length}件 追加（交差判定用: ${spectreTagMap.size}件）`);
    }

    await updateRunningRun(
      supabase,
      run.id,
      { spectre_done_at: new Date().toISOString(), total_prepared: totalPrepared },
      'Spectre監査更新失敗',
    );

    // ---- 7. 重複排除 ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 45, 100, '重複排除中...');
    console.log('[sync] 重複排除...');

    const cardsBeforeDedup = await fetchAllRunPreparedCards(supabase, run.id);
    for (const franchise of FRANCHISES) {
      const cards = cardsBeforeDedup.filter((card) => card.franchise === franchise);
      if (cards.length === 0) continue;

      const deduped = deduplicateByListNo(cards);
      const removedCount = cards.length - deduped.length;

      if (removedCount > 0) {
        const keepIds = new Set(deduped.map(c => c.id));
        const removeIds = cards.filter(c => !keepIds.has(c.id)).map(c => c.id);

        // バッチで削除（Supabase の in() 制限対策）
        for (let i = 0; i < removeIds.length; i += 100) {
          const batch = removeIds.slice(i, i + 100);
          const { error } = await supabase.from('prepared_card').delete().in('id', batch);
          if (error) throw new Error(`重複カード削除失敗: ${error.message}`);
        }
        console.log(`[sync]   ${franchise}: ${removedCount}件 重複除外`);
      }
    }

    // ---- 7b. Spectre ∩ オーダーリスト 交差処理 ----
    await lease.renewNow();
    // SpectreMapping と当日のオーダーリストの両方にあるカードだけを TOP に残す
    if (spectreTagMap.size > 0) {
      console.log('[sync] Spectre ∩ オーダーリスト 交差処理...');
      let tagUpdated = 0;
      let spectreOnlyRemoved = 0;
      const intersectionCards = await fetchAllRunPreparedCards(supabase, run.id);

      for (const franchise of FRANCHISES) {
        const cards = intersectionCards.filter((card) => card.franchise === franchise);
        if (cards.length === 0) continue;

        // source='order_list' で Spectre にもある → tag を Spectre の tag に上書き
        const updateIds: { id: string; tag: string }[] = [];
        for (const card of cards) {
          if (card.source !== 'order_list' || !card.list_no) continue;
          const key = spectreIntersectionKey(card.franchise, card.list_no, card.grade);
          const spectreTag = spectreTagMap.get(key);
          if (spectreTag) {
            updateIds.push({ id: card.id, tag: spectreTag });
          }
        }

        for (const { id, tag } of updateIds) {
          const { error } = await supabase.from('prepared_card').update({ tag }).eq('id', id);
          if (error) throw new Error(`Spectreタグ更新失敗: ${error.message}`);
        }
        tagUpdated += updateIds.length;

        // source='spectre'（オーダーリストにない）→ 削除
        const spectreOnlyIds = cards
          .filter(c => c.source === 'spectre')
          .map(c => c.id);

        for (let i = 0; i < spectreOnlyIds.length; i += 100) {
          const batch = spectreOnlyIds.slice(i, i + 100);
          const { error } = await supabase.from('prepared_card').delete().in('id', batch);
          if (error) throw new Error(`Spectre単独カード削除失敗: ${error.message}`);
        }
        spectreOnlyRemoved += spectreOnlyIds.length;
      }

      totalPrepared -= spectreOnlyRemoved;
      console.log(`[sync] 交差処理完了: オーダーリスト→TOP タグ付与 ${tagUpdated}件, Spectreのみ削除 ${spectreOnlyRemoved}件`);
    }

    // ---- 8. 画像ヘルスチェック ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 50, 100, '画像ヘルスチェック中...');
    console.log('[sync] 画像ヘルスチェック...');

    const allPrepared = await fetchAllRunPreparedCards(supabase, run.id);
    const deadCount = await checkImageHealth(supabase, run.id, allPrepared);

    await updateRunningRun(
      supabase,
      run.id,
      { total_image_ng: deadCount, health_check_done_at: new Date().toISOString() },
      '画像ヘルスチェック監査更新失敗',
    );
    console.log(`[sync] 画像チェック完了: dead=${deadCount}`);

    // ---- 9. タグなしカード集計 ----
    await lease.renewNow();
    const { count: untaggedCount, error: untaggedError } = await supabase
      .from('prepared_card')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .is('tag', null);
    if (untaggedError) throw new Error(`タグなしカード集計失敗: ${untaggedError.message}`);

    const totalUntagged = untaggedCount ?? 0;

    // ---- 9b. 価格未記入カード集計 ----
    await lease.renewNow();
    const { count: priceMissingCount, error: priceMissingError } = await supabase
      .from('prepared_card')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .or('price_high.is.null,price_low.is.null,price_high.eq.0,price_low.eq.0');
    if (priceMissingError) throw new Error(`価格未記入カード集計失敗: ${priceMissingError.message}`);

    const totalPriceMissing = priceMissingCount ?? 0;

    await updateRunningRun(
      supabase,
      run.id,
      { total_untagged: totalUntagged, total_price_missing: totalPriceMissing },
      '除外カード監査更新失敗',
    );

    if (totalUntagged > 0) {
      console.warn(`[sync] ⚠️ タグなしカード: ${totalUntagged}件`);
    }
    if (totalPriceMissing > 0) {
      console.warn(`[sync] ⚠️ 価格未記入カード: ${totalPriceMissing}件`);
    }

    // ---- 10. ページプランニング ----
    await lease.renewNow();
    await updateProgress(supabase, run.id, 80, 100, 'ページプランニング中...');
    console.log('[sync] ページプランニング...');

    // dedup 後の最新 prepared_card を再取得
    const finalCards = await fetchAllRunPreparedCards(supabase, run.id);
    totalPrepared = finalCards.length;
    let totalPages = 0;

    for (const franchise of FRANCHISES) {
      const franchiseCards = finalCards.filter(c => c.franchise === franchise);
      if (franchiseCards.length === 0) continue;

      // タグなし・価格未記入カードを除外
      const validCards = franchiseCards.filter(c => c.tag && c.price_high != null && c.price_high > 0 && c.price_low != null && c.price_low > 0);
      const untaggedCards = franchiseCards.filter(c => !c.tag);
      const priceMissingCards = franchiseCards.filter(c => c.tag && (!c.price_high || !c.price_low));

      if (untaggedCards.length > 0) {
        console.warn(`[sync]   ${franchise}: タグ未設定 ${untaggedCards.length}件（除外）`);
        for (const c of untaggedCards.slice(0, 10)) {
          console.warn(`[sync]     - ${c.card_name} (${c.grade ?? ''} ${c.list_no ?? ''}) ¥${(c.price_high ?? 0).toLocaleString()}`);
        }
        if (untaggedCards.length > 10) {
          console.warn(`[sync]     ... 他 ${untaggedCards.length - 10}件`);
        }
      }

      if (priceMissingCards.length > 0) {
        console.warn(`[sync]   ${franchise}: 価格未記入 ${priceMissingCards.length}件（除外）`);
        for (const c of priceMissingCards.slice(0, 10)) {
          console.warn(`[sync]     - ${c.card_name} (${c.grade ?? ''} ${c.list_no ?? ''}) tag=${c.tag}`);
        }
        if (priceMissingCards.length > 10) {
          console.warn(`[sync]     ... 他 ${priceMissingCards.length - 10}件`);
        }
      }

      if (validCards.length === 0) continue;

      // asset_profile 取得（MANMAN店舗で分離）
      const { data: profileArr, error: profileError } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .limit(1)
        .returns<AssetProfileRow[]>();
      const profile = profileArr?.[0] ?? null;
      if (profileError || !profile) throw new Error(`asset_profile 取得失敗 (${STORE_NAME}/${franchise}): ${profileError?.message}`);

      // rule 取得（MANMAN店舗で分離）
      const { data: rules, error: rulesError } = await supabase
        .from('rule')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .returns<RuleRow[]>();
      if (rulesError) throw new Error(`rule 取得失敗: ${rulesError.message}`);

      // 既存MANMANの店舗レイアウト枠数を維持する。
      const pagePlans = planPages(validCards, rules ?? [], profile.total_slots);
      console.log(`[sync]   ${franchise}: ${pagePlans.length}ページ`);

      // タグ構成ログ
      const cardById = new Map(validCards.map(c => [c.id, c]));
      for (const plan of pagePlans) {
        const tagCounts = new Map<string, number>();
        for (const id of plan.cardIds) {
          const tag = cardById.get(id)?.tag || '?';
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
        const tagSummary = [...tagCounts.entries()]
          .map(([t, n]) => `${t}(${n})`)
          .join(', ');
        console.log(`[sync]     ${plan.label} [${plan.cardIds.length}枚]: ${tagSummary}`);
      }

      if (pagePlans.length === 0) continue;

      // generated_page レコードを insert
      const pageInserts: GeneratedPageInsert[] = pagePlans.map((plan, index) => ({
        run_id: run.id,
        franchise,
        page_index: index,
        page_label: plan.label,
        card_ids: plan.cardIds,
        status: 'pending' as const,
      }));
      await batchInsert(supabase, 'generated_page', pageInserts as unknown as Record<string, unknown>[]);

      totalPages += pagePlans.length;
      await updateProgress(supabase, run.id, 80 + Math.round((FRANCHISES.indexOf(franchise) + 1) / FRANCHISES.length * 15), 100, `${franchise}: ${pagePlans.length}ページ 計画完了`);
    }

    // ---- 完了 ----
    await lease.renewNow();
    await lease.stop();
    const completedAt = new Date().toISOString();
    const { error: finalizeError } = await supabase.rpc('finalize_order_list_sync', {
      p_import_id: orderListImport.id,
      p_run_id: run.id,
      p_total_prepared: totalPrepared,
      p_total_pages: totalPages,
      p_completed_at: completedAt,
    });
    if (finalizeError) {
      throw new Error(`Run/オーダーリスト反映完了更新失敗: ${finalizeError.message}`);
    }

    await clearProgress(supabase, run.id);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[sync] 完了: imported=${totalImported}, prepared=${totalPrepared}, untagged=${totalUntagged}, image_ng=${deadCount}, pages=${totalPages}`);

    // Discord 通知: 成功
    const fields = [
      { name: 'インポート', value: `${totalImported}件`, inline: true },
      { name: 'カード準備', value: `${totalPrepared}件`, inline: true },
      { name: 'ページ数', value: `${totalPages}ページ`, inline: true },
      { name: 'タグなし', value: `${totalUntagged}件`, inline: true },
      { name: '画像NG', value: `${deadCount}件`, inline: true },
      { name: '価格未記入', value: `${totalPriceMissing}件`, inline: true },
      { name: '所要時間', value: `${elapsed}秒`, inline: true },
    ];
    await sendDiscordNotification({
      title: '🟢 Sync ジョブ完了',
      description: process.env.TRIGGER === 'scheduler' ? '朝9時テストラン完了' : 'Sync が正常に完了しました',
      color: COLOR.SUCCESS,
      fields,
    });

    // 画像NG多発の警告
    if (deadCount > 10) {
      await sendDiscordNotification({
        title: '🟡 画像NG多発',
        description: `画像NG が ${deadCount} 件あります。確認してください。`,
        color: COLOR.WARNING,
      });
    }

    return;
  } catch (err) {
    await lease.stop();
    const message = err instanceof Error ? err.message : String(err);
    const failedAt = new Date().toISOString();
    const { error: failureStateError } = await supabase.rpc('fail_order_list_sync', {
      p_import_id: orderListImport.id,
      p_run_id: run.id,
      p_failure_message: message,
      p_failed_at: failedAt,
    });
    const failureStateMessage = failureStateError
      ? `${message}; 同期失敗状態の原子更新にも失敗: ${failureStateError.message}`
      : message;
    if (failureStateError) console.error(`[sync] ${failureStateMessage}`);
    await clearProgress(supabase, run.id);


    // Discord 通知: 失敗
    const isInvalidGrant = err instanceof OAuthInvalidGrantError;
    await sendDiscordNotification({
      title: isInvalidGrant ? '🔴 OAuth トークン失効' : '🔴 Sync ジョブ失敗',
      description: isInvalidGrant
        ? '再認証が必要です。管理画面からトークンを更新してください。'
        : failureStateMessage,
      color: COLOR.ERROR,
      fields: [
        { name: 'ジョブ', value: 'sync', inline: true },
        { name: 'トリガー', value: process.env.TRIGGER || 'manual', inline: true },
        { name: 'エラー', value: failureStateMessage.substring(0, 1000) },
      ],
    });

    if (failureStateError) {
      throw new Error(failureStateMessage);
    }
    throw err;
  }
}
