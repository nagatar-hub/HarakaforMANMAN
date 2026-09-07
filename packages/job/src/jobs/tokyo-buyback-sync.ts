import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calculateBoxPriceHigh, calculateBuyPriceHigh, isBuiltInOrderListExclusion,
  normalizeStorePricingSettings, tokyoBusinessDate,
  fetchShinsokuPostalProducts, matchShinsokuPostalProducts,
  type PostalCandidate, type StorePricingSettings, type Franchise,
} from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { isBoxRow } from '../lib/box-row.js';

export const TOKYO_BUYBACK_STORE = 'manman-akihabara';
const CHECKER_STORE = 'oripark';
const PAGE_SIZE = 500;

type OrderRow = { id: string; excel_product_id: string; franchise: string; card_name: string;
  list_no: string | null; grade: string | null; match_status: string };
type CheckerProduct = { source_product_id: number; category: string; name: string;
  full_name: string | null; model_number: string | null };
type CheckerOffer = { source_product_id: number; shop_id: number; condition_id: number; edition_id: number; edition_name?: string | null };

export function tokyoProductCandidates(orderRows: OrderRow[], products: CheckerProduct[], offers: CheckerOffer[]): PostalCandidate[] {
  const candidates: PostalCandidate[] = [];
  for (const row of orderRows) {
    if (['excluded', 'invalid'].includes(row.match_status) || isBuiltInOrderListExclusion(row.card_name)) continue;
    const grade = (row.grade ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
    const productType = isBoxRow(row) ? 'BOX' : grade === 'PSA10' ? 'PSA10' : null;
    if (productType) candidates.push({ source: 'kecak', id: row.excel_product_id,
      franchise: row.franchise, name: row.card_name, modelNumber: row.list_no, productType });
  }
  const productById = new Map(products.map(product => [product.source_product_id, product]));
  const seen = new Set<string>();
  for (const offer of offers) {
    if (![3, 13].includes(offer.shop_id) || ![1, 2].includes(offer.condition_id)) continue;
    const product = productById.get(offer.source_product_id);
    if (!product) throw new Error('買取チェッカーの商品・掲載一覧が一致しません');
    const franchise = ({ pokemon: 'Pokemon', one_piece: 'ONE PIECE' } as Record<string, string>)[product.category];
    if (!franchise) throw new Error(`未対応の買取チェッカーカテゴリ: ${product.category}`);
    // Different editions must not silently inherit the base product's price.
    const id = `${offer.source_product_id}:${offer.condition_id}:${offer.edition_id}`;
    const source = offer.shop_id === 3 ? 'toreca_bank' : 'avirile';
    const key = `${source}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ source, id, franchise, name: offer.edition_id ? `${product.name} [${offer.edition_name || `edition:${offer.edition_id}`}]` : product.name,
      modelNumber: product.model_number, productType: offer.condition_id === 1 ? 'PSA10' : 'BOX' });
  }
  return candidates;
}

async function allRows<T>(db: SupabaseClient, table: string, filters: Record<string, string>, order: string, select = '*'): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = db.from(table).select(select).range(offset, offset + PAGE_SIZE - 1);
    for (const column of order.split(',')) query = query.order(column);
    for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
    const { data, error } = await query;
    if (error) throw new Error(`${table} 読込失敗: ${error.message}`);
    rows.push(...(data ?? []) as unknown as T[]);
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

export async function buildTokyoBuybackSnapshot(db: SupabaseClient, now = new Date(), claim?: { claimedImportId: string; runId: string }) {
  const { data: order, error: orderError } = await db.from('order_list_import').select('*')
    .eq('store', TOKYO_BUYBACK_STORE).order('business_date', { ascending: false })
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order || !order.structural_valid || !order.persistence_complete
    || (claim ? order.id !== claim.claimedImportId || order.status !== 'processing' : order.status !== 'applied')) {
    throw new Error('東京満満の最新オーダーリストを反映してから価格を取得してください');
  }
  if (claim) {
    const { data: run, error } = await db.from('run').select('id,order_list_sync_request_id,order_list_sync_request_fingerprint')
      .eq('id', claim.runId).eq('store', TOKYO_BUYBACK_STORE).eq('order_list_import_id', order.id)
      .eq('status', 'running').maybeSingle();
    const heartbeatAge = now.getTime() - Date.parse(order.heartbeat_at);
    if (error || !run || run.order_list_sync_request_id !== order.order_list_sync_request_id
      || run.order_list_sync_request_fingerprint !== order.order_list_sync_request_fingerprint
      || !Number.isFinite(heartbeatAge) || heartbeatAge < -60_000 || heartbeatAge > 5 * 60_000) {
      throw new Error('東京満満の同期リースを所有するRunが必要です');
    }
  }
  const { data: checker, error: checkerError } = await db.from('kaitori_checker_sync_run').select('*')
    .eq('store', CHECKER_STORE).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (checkerError) throw new Error(checkerError.message);
  if (!checker || checker.status !== 'applied' || !checker.completed_at) {
    throw new Error('買取チェッカーの最新取得が完了していません');
  }
  const checkerAge = now.getTime() - Date.parse(checker.completed_at);
  if (!Number.isFinite(checkerAge) || checkerAge < -60_000 || checkerAge > 24 * 60 * 60 * 1000) {
    throw new Error('買取チェッカーの商品一覧が24時間以上更新されていません');
  }
  const [{ data: config, error: configError }, orderRows, products, offers] = await Promise.all([
    db.from('store_config').select('settings').eq('store', TOKYO_BUYBACK_STORE).single(),
    allRows<OrderRow>(db, 'order_list_item', { import_id: order.id }, 'id'),
    allRows<CheckerProduct>(db, 'kaitori_checker_product_snapshot', { run_id: checker.id, store: CHECKER_STORE }, 'source_product_id'),
    allRows<CheckerOffer>(db, 'kaitori_checker_offer_snapshot', { run_id: checker.id, store: CHECKER_STORE }, 'source_product_id,shop_id,condition_id,edition_id'),
  ]);
  if (configError || !config) throw new Error('東京満満の減額設定がありません');
  const settings = normalizeStorePricingSettings(config.settings);
  for (const rates of [Object.values(settings.psa10_discount_rates), Object.values(settings.box_discount_rates).flatMap(rate => [rate.shrink, rate.no_shrink])]) {
    if (rates.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)) throw new Error('減額率は0〜100%で設定してください');
  }
  if (products.length !== checker.product_count || offers.length !== checker.offer_count) throw new Error('買取チェッカーの保存件数が完了記録と一致しません');
  const candidates = tokyoProductCandidates(orderRows, products, offers);
  const sourceCounts = Object.fromEntries(['kecak', 'toreca_bank', 'avirile'].map(source => [source, candidates.filter(row => row.source === source).length]));
  if (Object.values(sourceCounts).some(count => count === 0)) throw new Error('3つの商品一覧のいずれかが空です');
  const sourceProducts = await fetchShinsokuPostalProducts({ candidates });
  const result = matchShinsokuPostalProducts(candidates, sourceProducts);
  const pricedRows = result.matched.map(({ product, sources }) => ({
    id: product.id, franchise: product.franchise, product_type: product.productType === 'BOX' ? 'box' : 'psa',
    name: product.name, model_number: product.modelNumber, image_url: product.imageUrl,
    source_price: product.price!, price_high: tokyoDisplayPrice(product.price!, product.franchise as Franchise, product.productType, settings),
    origins: sources,
  }));
  const rows = pricedRows.filter(row => row.price_high > 0);
  const unmatched = [...result.unmatched, ...pricedRows.filter(row => row.price_high <= 0)
    .flatMap(row => row.origins.map(candidate => ({ candidate, reason: 'zero_after_discount' as const })))];
  if (!rows.length) throw new Error('Shinsoku郵送価格に一致する掲載商品がありません');
  const fetchedAt = now.toISOString();
  return { snapshot: { id: randomUUID(), store: TOKYO_BUYBACK_STORE, order_list_import_id: order.id,
    checker_run_id: checker.id, checker_source_store: CHECKER_STORE, fetched_at: fetchedAt,
    business_date: tokyoBusinessDate(new Date(fetchedAt)), settings,
    report: { source_url: 'https://shinsoku-tcg.com/yuso-kaitori', completed_at: new Date().toISOString(), order_business_date: order.business_date,
      checker_completed_at: checker.completed_at, source_counts: sourceCounts, shinsoku_count: sourceProducts.length,
      matched_count: rows.length, unmatched_count: unmatched.length, unmatched } }, products: rows };
}

export function tokyoDisplayPrice(price: number, franchise: Franchise, type: 'PSA10' | 'BOX', settings: StorePricingSettings): number {
  return type === 'BOX' ? calculateBoxPriceHigh(price, settings.box_discount_rates[franchise].shrink)
    : calculateBuyPriceHigh(price, settings.psa10_discount_rates[franchise]);
}

export async function runTokyoBuybackSync(options: { dryRun?: boolean } = {}) {
  if (process.env.STORE_NAME !== TOKYO_BUYBACK_STORE) throw new Error('この価格取得は東京満満専用です');
  const db = await createSupabaseClientFromSecrets() as unknown as SupabaseClient;
  const snapshot = await buildTokyoBuybackSnapshot(db);
  if (!options.dryRun) {
    const { data, error } = await db.rpc('publish_tokyo_buyback_snapshot', { p_snapshot: snapshot.snapshot, p_products: snapshot.products });
    if (error || data !== snapshot.snapshot.id) throw new Error(`東京価格の反映失敗: ${error?.message ?? 'snapshot mismatch'}`);
  }
  const { unmatched, ...summary } = snapshot.snapshot.report;
  console.log(JSON.stringify({ dry_run: options.dryRun === true, ...summary, snapshot_id: snapshot.snapshot.id }));
  return snapshot;
}
