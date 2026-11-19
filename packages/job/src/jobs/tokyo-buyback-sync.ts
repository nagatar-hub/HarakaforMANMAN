import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  calculateBoxPriceHigh, calculateBuyPriceHigh, isBuiltInOrderListExclusion,
  normalizeStorePricingSettings, postalProductIdentity, tokyoBoxAliasName, tokyoBusinessDate,
  fetchShinsokuPostalProducts, TOKYO_PRICE_SOURCES, validateTokyoSourceDiscountRates, validateTokyoOutlierGuard,
  validateTokyoPriceMaxAgeDays,
  type PostalCandidate, type ShinsokuPostalProduct, type StorePricingSettings, type Franchise, type TokyoPriceSource, type TokyoOutlierGuard,
} from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { isBoxRow } from '../lib/box-row.js';
import { fetchCheckerShops } from '../lib/kaitori-checker-shops.js';
import { blueRocketQuantityKey, blueRocketModelQuantityKey, blueRocketSingleQuantityKeys, fetchBlueRocketQuantityQuotes,
  type BlueRocketQuantityQuote } from '../lib/blue-rocket-quantity.js';
import { completeOriparkCoverage, loadOriparkCoverage } from '../lib/oripark-coverage.js';
import {
  EXTORECA_BOX_SHEET_URL, EXTORECA_PSA_SHEET_URL, extorecaPsaCandidates,
  fetchExtorecaBoxSheet, fetchExtorecaPsaSheet, type ExtorecaRow,
} from '../lib/extoreca-sheet.js';

export const TOKYO_BUYBACK_STORE = 'manman-akihabara';
const PAGE_SIZE = 500;
const MAX_PRICE = 100_000_000;
const KECAK_FRANCHISES = ['Pokemon', 'ONE PIECE', 'DRAGON BALL', 'WEISS SCHWARZ'];

type OrderRow = { id: string; excel_product_id: string; franchise: string; card_name: string;
  list_no: string | null; grade: string | null; match_status: string; source_price: number | null;
  rarity?: string | null; image_url?: string | null; demand?: number | null;
  db_card_id?: string | null; db_card?: { tag: string | null } | null };
type CheckerProduct = { source_product_id: number; category: string; name: string;
  full_name: string | null; model_number: string | null; image_url?: string | null;
  rarity?: string | null; holo_type?: string | null; aspect?: string | null };
type CheckerOffer = { source_product_id: number; shop_id: number; condition_id: number; edition_id: number;
  shop_name?: string; edition_name?: string | null; buy_price?: number; source_updated_at?: string | null };
export type TokyoCandidate = Omit<PostalCandidate, 'source'> & { source: TokyoPriceSource; sourceProductId?: number;
  conditionId?: number; sourcePrice?: number | null; dbCardId?: string | null; imageUrl?: string | null;
  rarity?: string | null; observedAt?: string | null; priceStale?: boolean; matchName?: string;
  shopId?: number; shopName?: string };
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

// PSA10・BOXとも秋葉原昭和通り店だけを参照する。
// トレカバンク・アヴィリールはラインアップにも価格比較にも使わない（2026-09-26 決定）。
const CHECKER_SOURCES: Partial<Record<number, TokyoPriceSource>> = {
  11: 'blue_rocket',
};
const BLUE_ROCKET_SHOP_NAME = 'Blue Rocket（ブルロケ）秋葉原昭和通り店';
const CHECKER_PSA_CONDITION_ID = 1;
const CHECKER_BOX_CONDITION_ID = 2;
const validPrice = (price: number | null | undefined): price is number =>
  Number.isSafeInteger(price) && price! > 0 && price! <= MAX_PRICE;

export function calculateTokyoExtorecaBoxPrice(shinsokuPrice: number, requestedPrice: number): number | null {
  if (!Number.isSafeInteger(shinsokuPrice) || shinsokuPrice <= 0 || shinsokuPrice > MAX_PRICE - 100
    || !Number.isSafeInteger(requestedPrice) || requestedPrice <= 0 || requestedPrice > MAX_PRICE) {
    return null;
  }
  const finalPrice = requestedPrice * 100 >= shinsokuPrice * 115
    ? Math.floor(requestedPrice / 110) * 100
    : Math.floor(requestedPrice * 10 / 1035) * 100;
  return finalPrice > 0 ? finalPrice : null;
}
/** 業務日から見た元価格の経過日数。未来日や解釈不能な値は null。 */
const priceAgeDays = (value: string | null | undefined, businessDate: string): number | null => {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const observed = Date.parse(`${tokyoBusinessDate(date)}T00:00:00+09:00`);
  const base = Date.parse(`${businessDate}T00:00:00+09:00`);
  if (!Number.isFinite(observed) || !Number.isFinite(base)) return null;
  const age = Math.round((base - observed) / 86_400_000);
  return age < 0 ? null : age;
};
const withinPriceAge = (value: string | null | undefined, businessDate?: string, maxAgeDays = 0) => {
  if (!businessDate) return true;
  const age = priceAgeDays(value, businessDate);
  return age !== null && age <= maxAgeDays;
};

/** Variant metadata is part of the card identity, not a display label to discard. */
function checkerPsaName(product: CheckerProduct): string {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const variants = [product.aspect, product.holo_type].filter((value): value is string => !!value?.trim());
  // A parallel rarity without a known design must never inherit the plain card's price.
  if (product.category === 'one_piece' && /\/P(?:\/|$)/i.test(product.rarity ?? '') && !variants.length) {
    variants.push(`レアリティ:${product.rarity}`);
  }
  return product.name + [...new Set(variants)].filter(value => !normalize(product.name).includes(normalize(value)))
    .map(value => `(${value})`).join('');
}

/** Preserve the existing exact-name check when another source has the same model number. */
export function selectCheckerPsaCandidates(rows: TokyoCandidate[],
  lineup: Pick<PostalCandidate, 'franchise' | 'name' | 'modelNumber' | 'productType'>[]) {
  const modelKey = (row: Pick<PostalCandidate, 'franchise' | 'modelNumber'>) => JSON.stringify([row.franchise,
    (row.modelNumber ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')]);
  const psa = lineup.filter(row => row.productType === 'PSA10' && row.modelNumber?.trim());
  const identities = new Set(psa.map(row => postalProductIdentity(row)));
  const models = new Set(psa.map(modelKey));
  const used: TokyoCandidate[] = [];
  const skipped: TokyoCandidate[] = [];
  for (const row of rows) {
    if (!row.modelNumber?.trim() || identities.has(postalProductIdentity(row)) || !models.has(modelKey(row))) used.push(row);
    else skipped.push(row);
  }
  return { used, skipped };
}

/** Remove single-card quotes before choosing the best branch, so another branch can still win. */
export function filterSingleQuantityBlueRocketOffers(products: CheckerProduct[], offers: CheckerOffer[],
  quotes: BlueRocketQuantityQuote[], unavailableShopIds: readonly number[] = []) {
  const singleKeys = blueRocketSingleQuantityKeys(quotes);
  const exactKeys = new Set(quotes.filter(quote => quote.identity).map(blueRocketQuantityKey));
  const singleModelKeys = blueRocketSingleQuantityKeys(quotes, true);
  const unavailable = new Set(unavailableShopIds);
  const productById = new Map(products.map(product => [product.source_product_id, product]));
  const excluded: (CheckerOffer & { quantity_exclusion_reason: 'single_quantity' | 'quantity_api_unavailable' })[] = [];
  const eligible = offers.filter(offer => {
    if (CHECKER_SOURCES[offer.shop_id] !== 'blue_rocket' || offer.condition_id !== CHECKER_PSA_CONDITION_ID) return true;
    if (unavailable.has(offer.shop_id)) {
      excluded.push({ ...offer, quantity_exclusion_reason: 'quantity_api_unavailable' });
      return false;
    }
    if (!validPrice(offer.buy_price)) return true;
    const product = productById.get(offer.source_product_id);
    if (!product) return true;
    const franchise = ({ pokemon: 'Pokemon', one_piece: 'ONE PIECE' } as Record<string, string>)[product.category];
    if (!franchise) return true;
    const identity = postalProductIdentity({ franchise, name: checkerPsaName(product),
      modelNumber: product.model_number, productType: 'PSA10' });
    const exactKey = blueRocketQuantityKey({ shopId: offer.shop_id, identity, price: offer.buy_price });
    const single = exactKeys.has(exactKey) ? singleKeys.has(exactKey)
      : product.model_number && singleModelKeys.has(blueRocketModelQuantityKey(offer.shop_id, franchise, product.model_number, product.name, offer.buy_price));
    if (!single) return true;
    excluded.push({ ...offer, quantity_exclusion_reason: 'single_quantity' });
    return false;
  });
  return { offers: eligible, excluded };
}

// KECAK の ONE PIECE PSA10 は素のカード名で来るため、柄がシンソク表記と一対一に決まる DB タグに限り柄を補って照合する。
const KECAK_PSA_TAG_LABELS = new Map([
  ['コミパラ', '(パラレル/漫画背景/漫画絵)'],
  ['コミパラ/レッド', '(レッドパラレル/漫画背景/漫画絵)'],
  ['パラレル/手配書', '(パラレル/手配書)'],
  ['タロット', '(パラレル/SP/タロット柄)'],
]);
// タグで柄が決まらない KECAK の DB カードは、画像で同一と確認したシンソク商品へ個別に寄せる（2026-10-31 確認）。
const KECAK_PSA_REVIEWED_SHINSOKU = new Map([
  ['db760ce6-2f1c-4c7f-9dbb-6f10307efdea', 'IAO2300025603'], // OP05-060 紫ルフィリーダーパラレル
  ['618d8e52-5ed6-4cfe-b0b8-a35626618753', 'IAO2500002145'], // OP06-118 2周年ゾロ
  ['c5a2eb2a-d968-47e2-b28b-8489ebb9ccd7', 'IAO2600003872'], // P-055 バスケルフィ
  ['08b09c7a-e9ac-4d19-820f-204dd30346db', 'IAO2600005097'], // OP12-034 3周年ペローナ
  ['c1bca4ed-18d3-4144-a3ec-873c09e25f72', 'IAO2500002757'], // OP08-067 フラシプリン
  ['6487f3dc-ce27-4d7d-b1bc-79d64c723566', 'IAO2600006892'], // EB02-010 ドジャースルフィ
  ['adb91b84-e0b0-422d-8a5a-03781718b907', 'IAO2600004003'], // OP02-001 赤ニューゲートリーダーパラレル
  ['926efc8e-274f-4b75-98c4-0e19e6a6825a', 'IAO2600004002'], // OP08-001 赤緑チョッパーリーダーパラレル
  ['7aa0c0b9-4cd2-4e09-9a16-cccbcdae8a1e', 'IAO2400003813'], // OP09-022 緑紫リムリーダーパラレル
  ['0edc94bf-19c4-4548-bb42-7d1e6cabd05b', 'IAO2400000042'], // OP05-069-M コミパラロー
  ['3b5d39f8-e2b2-4c43-97d3-60c5bd1961db', 'IAO2400000305'], // ST01-012-P 手配書ルフィ
  ['8c16f6c4-44d8-4b4e-86e5-5a6d6bb0add1', 'IAO2400000178'], // OP06-101-P お祭りおナミ
  ['3c08a750-ebab-4c14-9461-864558050f78', 'IAO2400000702'], // OP02-013-P 和柄エース
  ['09227b9f-dd5a-4685-8ddd-377bab44d482', 'IAO2500000215'], // EB01-056 フランぺ（シンソクは EB01-056[OP10]）
  ['e1058b1a-0af4-4467-bf46-a3a794b779ef', 'IAO2400000661'], // OP01-016-R 中国赤ナミ
]);

export function tokyoProductCandidates(orderRows: OrderRow[], products: CheckerProduct[], offers: CheckerOffer[],
  options: { businessDate?: string; kecakObservedAt?: string | null; kecakBusinessDate?: string;
    maxPriceAgeDays?: number } = {}): TokyoCandidate[] {
  const candidates: TokyoCandidate[] = [];
  // 古いオーダーリストでも商品自体はラインアップに残すが、金額は許容経過日数内のものだけを比較へ出す。
  // 鮮度は取込時刻ではなくオーダーリスト自身の業務日で判定する。
  const kecakPriceIsCurrent = withinPriceAge(options.kecakBusinessDate
    ? `${options.kecakBusinessDate}T00:00:00+09:00` : null, options.businessDate, options.maxPriceAgeDays ?? 0);
  for (const row of orderRows) {
    if (!KECAK_FRANCHISES.includes(row.franchise)) continue;
    if (['excluded', 'invalid'].includes(row.match_status) || isBuiltInOrderListExclusion(row.card_name)) continue;
    const grade = (row.grade ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
    const productType = isBoxRow(row) ? 'BOX' : grade === 'PSA10' ? 'PSA10' : null;
    const label = productType === 'PSA10' && row.franchise === 'ONE PIECE'
      ? KECAK_PSA_TAG_LABELS.get(row.db_card?.tag?.trim() ?? '') : undefined;
    if (productType) candidates.push({ source: 'kecak', id: row.excel_product_id,
      franchise: row.franchise, name: row.card_name, modelNumber: row.list_no, productType,
      sourcePrice: kecakPriceIsCurrent ? row.source_price : null, priceStale: !kecakPriceIsCurrent,
      dbCardId: row.db_card_id, observedAt: options.kecakObservedAt,
      ...(productType === 'PSA10' && row.franchise === 'DRAGON BALL' && ('image_url' in row || 'rarity' in row)
        ? { imageUrl: row.image_url ?? null, rarity: row.rarity ?? null } : {}),
      ...(label ? { matchName: `${row.card_name}${label}` } : {}) });
  }
  const productById = new Map(products.map(product => [product.source_product_id, product]));
  const checkerCandidates = new Map<string, TokyoCandidate>();
  for (const offer of offers) {
    const source = CHECKER_SOURCES[offer.shop_id];
    if (!source || ![CHECKER_PSA_CONDITION_ID, CHECKER_BOX_CONDITION_ID].includes(offer.condition_id)
      || !withinPriceAge(offer.source_updated_at, options.businessDate, options.maxPriceAgeDays ?? 0)) continue;
    const product = productById.get(offer.source_product_id);
    if (!product) throw new Error('買取チェッカーの商品・掲載一覧が一致しません');
    const franchise = ({ pokemon: 'Pokemon', one_piece: 'ONE PIECE' } as Record<string, string>)[product.category];
    if (!franchise) throw new Error(`未対応の買取チェッカーカテゴリ: ${product.category}`);
    // Different editions must not silently inherit the base product's price.
    const id = `${offer.source_product_id}:${offer.condition_id}:${offer.edition_id}`;
    const key = `${source}:${id}`;
    const current = checkerCandidates.get(key);
    // Compare only usable prices from the same exact product/condition/edition.
    // Ties retain the smaller shop ID so response ordering cannot change provenance.
    if (current && validPrice(current.sourcePrice) && (!validPrice(offer.buy_price)
      || current.sourcePrice > offer.buy_price
      || (current.sourcePrice === offer.buy_price && current.shopId! <= offer.shop_id))) continue;
    const productType = offer.condition_id === CHECKER_PSA_CONDITION_ID ? 'PSA10' : 'BOX';
    const name = productType === 'PSA10' ? checkerPsaName(product) : product.name;
    checkerCandidates.set(key, { source, id, franchise, name: offer.edition_id ? `${name} [${offer.edition_name || `edition:${offer.edition_id}`}]` : name,
      modelNumber: product.model_number, productType, ...(product.rarity ? { rarity: product.rarity } : {}),
      sourceProductId: offer.source_product_id, conditionId: offer.condition_id, sourcePrice: offer.buy_price,
      imageUrl: product.image_url, observedAt: offer.source_updated_at,
      shopId: offer.shop_id, shopName: BLUE_ROCKET_SHOP_NAME });
  }
  candidates.push(...checkerCandidates.values());
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
  // KECAK をシンソク商品へ寄せるのは、価格のあるシンソク商品がちょうど1件ある識別子だけ。無ければ従来の識別子（＝商品ID）を保つ。
  const shinsokuIdentityById = new Map(shinsokuProducts.filter(product => validPrice(product.price))
    .map(product => [product.id, postalProductIdentity(product)]));
  const shinsokuIdentityCount = new Map<string, number>();
  for (const identity of shinsokuIdentityById.values()) shinsokuIdentityCount.set(identity, (shinsokuIdentityCount.get(identity) ?? 0) + 1);
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
    const reviewed = candidate.dbCardId ? KECAK_PSA_REVIEWED_SHINSOKU.get(candidate.dbCardId) : undefined;
    const target = reviewed ? shinsokuIdentityById.get(reviewed)
      : candidate.matchName ? postalProductIdentity({ ...candidate, name: candidate.matchName }) : undefined;
    const identity = target && shinsokuIdentityCount.get(target) === 1 ? target
      : postalProductIdentity({ ...candidate, name: tokyoBoxAliasName(candidate) });
    groups.set(identity, [...(groups.get(identity) ?? []), candidate]);
  }

  const products = [];
  for (const [identity, group] of groups) {
    const bySource = new Map<TokyoPriceSource, TokyoCandidate[]>();
    for (const candidate of group) bySource.set(candidate.source, [...(bySource.get(candidate.source) ?? []), candidate]);
    if ([...bySource.values()].some(rows => new Set(rows.map(row => `${row.id}:${row.sourcePrice}`)).size > 1
      || rows[0]?.source === 'kecak' && rows[0].franchise === 'DRAGON BALL' && rows[0].productType === 'PSA10'
      && rows.some(row => row.imageUrl !== rows[0].imageUrl || row.rarity !== rows[0].rarity))) {
      unmatched.push(...group.map(candidate => ({ candidate, reason: 'ambiguous' as const })));
      continue;
    }
    const origins: ComparedOrigin[] = TOKYO_PRICE_SOURCES.flatMap(source => {
      const candidate = bySource.get(source)?.[0];
      if (!candidate || !validPrice(candidate.sourcePrice)) return [];
      const rates = settings.tokyo_source_discount_rates[source];
      const { matchName: _matchName, ...origin } = candidate;
      return [{ ...origin, rawPrice: candidate.sourcePrice,
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
    const extoreca = compared.find(origin => origin.source === 'extoreca');
    const marginShinsoku = compared.find(origin => origin.source === 'shinsoku');
    let marginPrice: number | null = null;
    if (extoreca?.franchise === 'Pokemon' && extoreca.productType === 'BOX' && marginShinsoku) {
      const calculated = calculateTokyoExtorecaBoxPrice(marginShinsoku.rawPrice, extoreca.rawPrice);
      if (calculated !== null) {
        marginPrice = calculated;
        extoreca.highRate = 1 - marginPrice / extoreca.rawPrice;
        extoreca.highPrice = marginPrice;
        extoreca.lowRate = extoreca.highRate;
        extoreca.lowPrice = marginPrice;
      }
    }
    const eligible = compared.filter(origin => origin.highPrice > 0);
    if (!eligible.length) {
      unmatched.push(...group.map(candidate => ({ candidate, reason: 'zero_after_discount' as const })));
      continue;
    }
    // 対象BOXはExtoreca利益率価格を採用し、それ以外は従来どおり減額後の最高額を採用する。
    const high = marginPrice !== null && extoreca ? extoreca : eligible.reduce((winner, origin) => origin.highPrice > winner.highPrice
      || (origin.highPrice === winner.highPrice && origin.rawPrice > winner.rawPrice) ? origin : winner);
    const low = high;
    const canonical = bySource.get('shinsoku')?.[0] ?? bySource.get('kecak')?.[0] ?? compared[0];
    const shinsoku = bySource.get('shinsoku')?.[0];
    products.push({
      id: shinsoku?.id ?? `TOKYO_${createHash('sha256').update(identity).digest('hex')}`,
      franchise: canonical.franchise,
      product_type: canonical.productType === 'BOX' ? 'box' as const : 'psa' as const,
      name: tokyoBoxAliasName(canonical),
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
  const [{ data: config, error: configError }, orderRows] = await Promise.all([
    db.from('store_config').select('settings').eq('store', TOKYO_BUYBACK_STORE).single(),
    allRows<OrderRow>(db, 'order_list_item', { import_id: order.id }, 'id', '*, db_card(tag)'),
  ]);
  if (configError || !config) throw new Error('東京満満の減額設定がありません');
  const settings = normalizeStorePricingSettings(config.settings);
  const tokyoRateError = validateTokyoSourceDiscountRates(settings.tokyo_source_discount_rates)
    ?? validateTokyoOutlierGuard(settings.tokyo_outlier_guard)
    ?? validateTokyoPriceMaxAgeDays(settings.tokyo_price_max_age_days);
  if (tokyoRateError) throw new Error(tokyoRateError);
  for (const rates of [Object.values(settings.psa10_discount_rates), Object.values(settings.box_discount_rates).flatMap(rate => [rate.shrink, rate.no_shrink])]) {
    if (rates.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)) throw new Error('減額率は0〜100%で設定してください');
  }
  const [checker, quantities] = await Promise.all([
    fetchCheckerShops(Object.keys(CHECKER_SOURCES).map(Number), [CHECKER_PSA_CONDITION_ID, CHECKER_BOX_CONDITION_ID]),
    fetchBlueRocketQuantityQuotes(businessDate, settings.tokyo_price_max_age_days),
  ]);
  const quantityFailedShopIds = quantities.report.shops.filter(shop => shop.error).map(shop => shop.shop_id);
  const quantityFiltered = filterSingleQuantityBlueRocketOffers(checker.products, checker.offers, quantities.quotes, quantityFailedShopIds);
  let candidates = tokyoProductCandidates(orderRows, checker.products, quantityFiltered.offers, {
    businessDate, kecakBusinessDate: order.business_date,
    kecakObservedAt: order.created_at ?? `${order.business_date}T00:00:00+09:00`,
    maxPriceAgeDays: settings.tokyo_price_max_age_days,
  });
  // Pull the public catalog first; Tokyo order-list names and model numbers never leave Haraka.
  const sourceProducts = await fetchShinsokuPostalProducts();
  const fetchedAt = now.toISOString();
  const blueRocketPsa = selectCheckerPsaCandidates(
    candidates.filter(row => row.source === 'blue_rocket' && row.productType === 'PSA10'), [
    ...candidates.filter(row => row.source === 'kecak'),
    ...sourceProducts,
  ]);
  candidates = candidates.filter(row => row.source !== 'blue_rocket' || row.productType !== 'PSA10')
    .concat(blueRocketPsa.used);
  const extorecaTabs = await Promise.allSettled([fetchExtorecaBoxSheet(), fetchExtorecaPsaSheet()]);
  let extorecaBox: ExtorecaRow[] = [];
  let extorecaPsa: ReturnType<typeof extorecaPsaCandidates> = { used: [], skipped: [] };
  const extorecaErrors: { box: string | null; psa: string | null } = { box: null, psa: null };
  if (extorecaTabs[0].status === 'fulfilled') extorecaBox = extorecaTabs[0].value;
  else extorecaErrors.box = extorecaTabs[0].reason instanceof Error
    ? extorecaTabs[0].reason.message : String(extorecaTabs[0].reason);
  if (extorecaTabs[1].status === 'fulfilled') {
    extorecaPsa = extorecaPsaCandidates(extorecaTabs[1].value, [
      ...candidates.filter(row => row.source === 'kecak' || row.source === 'blue_rocket'),
      ...sourceProducts,
    ]);
  } else extorecaErrors.psa = extorecaTabs[1].reason instanceof Error
    ? extorecaTabs[1].reason.message : String(extorecaTabs[1].reason);
  for (const error of Object.values(extorecaErrors)) if (error) console.warn(`[tokyo-buyback] ${error}`);
  candidates.push(...[...extorecaBox, ...extorecaPsa.used].map(row => ({
    source: 'extoreca' as const, id: row.id, franchise: 'Pokemon', name: row.name, modelNumber: row.modelNumber,
    productType: row.productType, sourcePrice: row.price, imageUrl: null, observedAt: fetchedAt,
  })));
  // ラインアップは4ソース（KECAK・シンソク・ブルーロケット・エクストレカ）の和集合で、金額は比較候補でしかない。許容経過日数内の価格を
  // 持たないソースはその日の比較に参加しないだけで、掲載全体を止める理由にはしない。
  const sourceCounts = Object.fromEntries(TOKYO_PRICE_SOURCES.map(source => [source, source === 'shinsoku'
    ? sourceProducts.filter(product => validPrice(product.price)).length
    : candidates.filter(row => row.source === source && validPrice(row.sourcePrice)).length]));
  const result = compareTokyoSourceProducts(candidates, sourceProducts, settings, fetchedAt);
  const coverage = process.env.TOKYO_ORIPARK_COVERAGE_ENABLED === 'true'
    ? completeOriparkCoverage(result, await loadOriparkCoverage(db), businessDate,
      settings.tokyo_price_max_age_days, candidate => compareTokyoSourceProducts([candidate], [], settings, fetchedAt)) : null;
  if (!result.products.length) throw new Error('当日価格で掲載可能な商品がありません');
  return { snapshot: { id: randomUUID(), store: TOKYO_BUYBACK_STORE, order_list_import_id: order.id,
    checker_run_id: null, checker_source_store: TOKYO_BUYBACK_STORE, fetched_at: fetchedAt,
    business_date: businessDate, settings,
    report: { pricing_version: 2, ...(coverage ? { oripark_coverage: coverage } : {}), source_url: 'https://shinsoku-tcg.com/yuso-kaitori', completed_at: new Date().toISOString(), order_business_date: order.business_date,
      checker_api: checker.report, source_counts: sourceCounts, shinsoku_count: sourceProducts.length,
      blue_rocket_psa: { source: 'kaitori_checker', used: blueRocketPsa.used.length, skipped: blueRocketPsa.skipped,
        quantity: { ...quantities.report, failed_shop_ids: quantityFailedShopIds,
          excluded_single_quantity_count: quantityFiltered.excluded.filter(offer => offer.quantity_exclusion_reason === 'single_quantity').length,
          excluded_quantity_unavailable_count: quantityFiltered.excluded.filter(offer => offer.quantity_exclusion_reason === 'quantity_api_unavailable').length,
          excluded: quantityFiltered.excluded } },
      extoreca: {
        box: { url: EXTORECA_BOX_SHEET_URL, used: extorecaBox.length, error: extorecaErrors.box },
        psa: { url: EXTORECA_PSA_SHEET_URL, used: extorecaPsa.used.length, skipped: extorecaPsa.skipped, error: extorecaErrors.psa },
      },
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
  const { unmatched, oripark_coverage: coverage, ...summary } = snapshot.snapshot.report;
  console.log(JSON.stringify({ dry_run: options.dryRun === true, ...summary,
    oripark_coverage: coverage ? { runId: coverage.runId, count: coverage.items.length, fingerprint: coverage.fingerprint } : null,
    snapshot_id: snapshot.snapshot.id }));
  return snapshot;
}
