import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calculateBoxPriceHigh, calculateBuyPriceHigh, isBuiltInOrderListExclusion,
  normalizeStorePricingSettings, postalProductIdentity, tokyoBusinessDate,
  fetchShinsokuPostalProducts, TOKYO_PRICE_SOURCES, validateTokyoSourceDiscountRates, validateTokyoOutlierGuard,
  type PostalCandidate, type ShinsokuPostalProduct, type StorePricingSettings, type Franchise, type TokyoPriceSource, type TokyoOutlierGuard,
} from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { isBoxRow } from '../lib/box-row.js';

export const TOKYO_BUYBACK_STORE = 'manman-akihabara';
const CHECKER_STORE = 'oripark';
const PAGE_SIZE = 500;
const KECAK_FRANCHISES = ['Pokemon', 'ONE PIECE', 'DRAGON BALL', 'WEISS SCHWARZ'];

type OrderRow = { id: string; excel_product_id: string; franchise: string; card_name: string;
  list_no: string | null; grade: string | null; match_status: string; source_price: number | null;
  demand?: number | null; db_card_id?: string | null };
type CheckerProduct = { source_product_id: number; category: string; name: string;
  full_name: string | null; model_number: string | null; image_url?: string | null };
type CheckerOffer = { source_product_id: number; shop_id: number; condition_id: number; edition_id: number;
  edition_name?: string | null; buy_price?: number; source_updated_at?: string | null };
export type TokyoCandidate = Omit<PostalCandidate, 'source'> & { source: TokyoPriceSource; sourceProductId?: number;
  conditionId?: number; sourcePrice?: number | null; dbCardId?: string | null; imageUrl?: string | null;
  observedAt?: string | null; priceStale?: boolean };
type ComparedOrigin = TokyoCandidate & { rawPrice: number; highRate: number; highPrice: number;
  lowRate: number; lowPrice: number; excluded?: true };

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * 1店舗だけの異常な元価格を採用対象から落とす。
 * 先に絶対上限で切り、残った相手との中央値比で相対的な外れ値を落とす。
 * 比較相手が居ない単独ソースは絶対上限だけで判定する。
 */
export function tokyoComparableOrigins(origins: ComparedOrigin[], guard: TokyoOutlierGuard): ComparedOrigin[] {
  const withinCap = origins.filter(origin => origin.rawPrice <= guard.max_source_price);
  return withinCap.filter(origin => {
    const others = withinCap.filter(row => row !== origin).map(row => row.rawPrice);
    return !others.length || origin.rawPrice <= median(others) * guard.max_median_ratio;
  });
}

const CHECKER_SOURCES: Partial<Record<number, TokyoPriceSource>> = {
  11: 'blue_rocket', 3: 'toreca_bank', 13: 'avirile',
};
const validPrice = (price: number | null | undefined): price is number =>
  Number.isSafeInteger(price) && price! > 0 && price! <= 100_000_000;
const currentTokyoDate = (value: string | null | undefined, businessDate?: string) => {
  if (!businessDate) return true;
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && tokyoBusinessDate(date) === businessDate;
};

export function tokyoProductCandidates(orderRows: OrderRow[], products: CheckerProduct[], offers: CheckerOffer[],
  options: { businessDate?: string; kecakObservedAt?: string | null; kecakBusinessDate?: string } = {}): TokyoCandidate[] {
  const candidates: TokyoCandidate[] = [];
  // 前日のオーダーリストでも商品自体はラインアップに残すが、金額は当日のものだけを比較へ出す。
  // 鮮度は取込時刻ではなくオーダーリスト自身の業務日で判定する。
  const kecakPriceIsCurrent = !options.businessDate || options.kecakBusinessDate === options.businessDate;
  for (const row of orderRows) {
    if (!KECAK_FRANCHISES.includes(row.franchise)) continue;
    if (['excluded', 'invalid'].includes(row.match_status) || isBuiltInOrderListExclusion(row.card_name)) continue;
    const grade = (row.grade ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
    const productType = isBoxRow(row) ? 'BOX' : grade === 'PSA10' ? 'PSA10' : null;
    if (productType) candidates.push({ source: 'kecak', id: row.excel_product_id,
      franchise: row.franchise, name: row.card_name, modelNumber: row.list_no, productType,
      sourcePrice: kecakPriceIsCurrent ? row.source_price : null, priceStale: !kecakPriceIsCurrent,
      dbCardId: row.db_card_id, observedAt: options.kecakObservedAt });
  }
  const productById = new Map(products.map(product => [product.source_product_id, product]));
  const seen = new Set<string>();
  for (const offer of offers) {
    const source = CHECKER_SOURCES[offer.shop_id];
    if (!source || ![1, 2].includes(offer.condition_id)
      || !currentTokyoDate(offer.source_updated_at, options.businessDate)) continue;
    const product = productById.get(offer.source_product_id);
    if (!product) throw new Error('買取チェッカーの商品・掲載一覧が一致しません');
    const franchise = ({ pokemon: 'Pokemon', one_piece: 'ONE PIECE' } as Record<string, string>)[product.category];
    if (!franchise) throw new Error(`未対応の買取チェッカーカテゴリ: ${product.category}`);
    // Different editions must not silently inherit the base product's price.
    const id = `${offer.source_product_id}:${offer.condition_id}:${offer.edition_id}`;
    const key = `${source}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ source, id, franchise, name: offer.edition_id ? `${product.name} [${offer.edition_name || `edition:${offer.edition_id}`}]` : product.name,
      modelNumber: product.model_number, productType: offer.condition_id === 1 ? 'PSA10' : 'BOX',
      sourceProductId: offer.source_product_id, conditionId: offer.condition_id, sourcePrice: offer.buy_price,
      imageUrl: product.image_url, observedAt: offer.source_updated_at });
  }
  return candidates;
}

export function compareTokyoSourceProducts(candidates: TokyoCandidate[], shinsokuProducts: ShinsokuPostalProduct[],
  settings: StorePricingSettings, observedAt: string) {
  const all: TokyoCandidate[] = [...candidates, ...shinsokuProducts.map(product => ({
    source: 'shinsoku' as const, id: product.id, franchise: product.franchise, name: product.name,
    modelNumber: product.modelNumber, productType: product.productType, sourcePrice: product.price,
    imageUrl: product.imageUrl, observedAt,
  }))];
  const groups = new Map<string, TokyoCandidate[]>();
  const unmatched: { candidate: TokyoCandidate; reason: 'missing_model' | 'invalid_price' | 'stale_price' | 'ambiguous' | 'zero_after_discount' | 'outlier_price' }[] = [];
  for (const candidate of all) {
    if (candidate.productType === 'PSA10' && !candidate.modelNumber?.trim()) {
      unmatched.push({ candidate, reason: 'missing_model' });
      continue;
    }
    if (!validPrice(candidate.sourcePrice)) {
      // 前日の金額は「不正」ではなく「当日でないので不参加」として区別する。
      unmatched.push({ candidate, reason: candidate.priceStale ? 'stale_price' : 'invalid_price' });
      continue;
    }
    const identity = postalProductIdentity(candidate);
    groups.set(identity, [...(groups.get(identity) ?? []), candidate]);
  }

  const products = [];
  for (const [identity, group] of groups) {
    const bySource = new Map<TokyoPriceSource, TokyoCandidate[]>();
    for (const candidate of group) bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate]);
    if ([...bySource.values()].some(rows => new Set(rows.map(row => `${row.id}:${row.sourcePrice}`)).size > 1)) {
      unmatched.push(...group.map(candidate => ({ candidate, reason: 'ambiguous' as const })));
      continue;
    }
    const origins: ComparedOrigin[] = TOKYO_PRICE_SOURCES.flatMap(source => {
      const candidate = bySource.get(source)?.[0];
      if (!candidate || !validPrice(candidate.sourcePrice)) return [];
      const rates = settings.tokyo_source_discount_rates[source];
      return [{ ...candidate, rawPrice: candidate.sourcePrice,
        highRate: rates.high, highPrice: tokyoDisplayPrice(candidate.sourcePrice, candidate.franchise as Franchise, candidate.productType, rates.high),
        lowRate: rates.low, lowPrice: tokyoDisplayPrice(candidate.sourcePrice, candidate.franchise as Franchise, candidate.productType, rates.low) }];
    });
    const compared = tokyoComparableOrigins(origins, settings.tokyo_outlier_guard);
    if (!compared.length) {
      unmatched.push(...group.map(candidate => ({ candidate, reason: 'outlier_price' as const })));
      continue;
    }
    const excluded = new Set(origins.filter(origin => !compared.includes(origin)).map(origin => origin.source));
    for (const origin of origins) if (excluded.has(origin.source)) origin.excluded = true;
    const eligible = compared.filter(origin => origin.highPrice > 0);
    if (!eligible.length) {
      unmatched.push(...group.map(candidate => ({ candidate, reason: 'zero_after_discount' as const })));
      continue;
    }
    const high = eligible.reduce((winner, origin) => origin.highPrice > winner.highPrice ? origin : winner);
    const low = compared.reduce((winner, origin) => origin.lowPrice > winner.lowPrice ? origin : winner);
    const canonical = bySource.get('shinsoku')?.[0] ?? bySource.get('kecak')?.[0] ?? compared[0];
    const shinsoku = bySource.get('shinsoku')?.[0];
    products.push({
      id: shinsoku?.id ?? `TOKYO_${createHash('sha256').update(identity).digest('hex')}`,
      franchise: canonical.franchise,
      product_type: canonical.productType === 'BOX' ? 'box' as const : 'psa' as const,
      name: canonical.name,
      model_number: canonical.modelNumber,
      image_url: canonical.imageUrl ?? origins.find(origin => origin.imageUrl)?.imageUrl ?? null,
      source_price: high.rawPrice,
      price_high: high.highPrice,
      price_low: low.lowPrice,
      selected_high_source: high.source,
      selected_low_source: low.source,
      origins,
    });
  }
  const priceSources = Object.fromEntries(products.map(product => [product.id, {
    source: product.selected_high_source, source_id: product.origins.find(origin => origin.source === product.selected_high_source)?.id,
    price: product.source_price,
  }]));
  return { products, unmatched, priceSources };
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
  const businessDate = tokyoBusinessDate(now);
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
    .eq('store', CHECKER_STORE).eq('status', 'applied').order('created_at', { ascending: false }).limit(1).maybeSingle();
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
  const tokyoRateError = validateTokyoSourceDiscountRates(settings.tokyo_source_discount_rates)
    ?? validateTokyoOutlierGuard(settings.tokyo_outlier_guard);
  if (tokyoRateError) throw new Error(tokyoRateError);
  for (const rates of [Object.values(settings.psa10_discount_rates), Object.values(settings.box_discount_rates).flatMap(rate => [rate.shrink, rate.no_shrink])]) {
    if (rates.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)) throw new Error('減額率は0〜100%で設定してください');
  }
  if (products.length !== checker.product_count || offers.length !== checker.offer_count) throw new Error('買取チェッカーの保存件数が完了記録と一致しません');
  const candidates = tokyoProductCandidates(orderRows, products, offers, {
    businessDate, kecakBusinessDate: order.business_date,
    kecakObservedAt: order.created_at ?? `${order.business_date}T00:00:00+09:00`,
  });
  // Pull the public catalog first; Tokyo order-list names and model numbers never leave Haraka.
  const sourceProducts = await fetchShinsokuPostalProducts();
  const fetchedAt = now.toISOString();
  // ラインアップは5ソースの和集合で、金額は比較候補でしかない。当日価格が無いソースは
  // その日の比較に参加しないだけで、掲載全体を止める理由にはしない。件数は報告に残す。
  const sourceCounts = Object.fromEntries(TOKYO_PRICE_SOURCES.map(source => [source, source === 'shinsoku'
    ? sourceProducts.filter(product => validPrice(product.price)).length
    : candidates.filter(row => row.source === source && validPrice(row.sourcePrice)).length]));
  const result = compareTokyoSourceProducts(candidates, sourceProducts, settings, fetchedAt);
  if (!result.products.length) throw new Error('当日価格で掲載可能な商品がありません');
  return { snapshot: { id: randomUUID(), store: TOKYO_BUYBACK_STORE, order_list_import_id: order.id,
    checker_run_id: checker.id, checker_source_store: CHECKER_STORE, fetched_at: fetchedAt,
    business_date: businessDate, settings,
    report: { pricing_version: 2, source_url: 'https://shinsoku-tcg.com/yuso-kaitori', completed_at: new Date().toISOString(), order_business_date: order.business_date,
      checker_completed_at: checker.completed_at, source_counts: sourceCounts, shinsoku_count: sourceProducts.length,
      price_sources: result.priceSources,
      matched_count: result.products.length, unmatched_count: result.unmatched.length, unmatched: result.unmatched } }, products: result.products };
}

export function tokyoDisplayPrice(price: number, _franchise: Franchise, type: 'PSA10' | 'BOX', discountRate: number): number {
  return type === 'BOX' ? calculateBoxPriceHigh(price, discountRate)
    : Math.floor(calculateBuyPriceHigh(price, discountRate) / 1_000) * 1_000;
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
