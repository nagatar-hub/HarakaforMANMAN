import { exclude, type ReportIssue } from './run-issues.js';
import { createHmac } from 'node:crypto';
import { fetchWithRetry } from './fetch-with-retry.js';
import { getSecret } from './secret-manager.js';

export const KAITORI_CHECKER_API_BASE = 'https://apn.kaitori-checker.com';
export type CheckerProduct = { source_product_id: number; category: string; name: string;
  full_name: string | null; model_number: string | null; image_url: string | null;
  rarity?: string | null; holo_type?: string | null; aspect?: string | null };
export type CheckerOffer = { source_product_id: number; shop_id: number; condition_id: number; edition_id: number;
  shop_name: string; edition_name: string | null; buy_price: number; source_updated_at: string | null };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const id = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return String(value).trim() && Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** The shop endpoint uses Japan local timestamps without a timezone. */
function updatedAt(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}+09:00` : raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseCheckerShop(value: unknown, shopId: number, conditionIds: readonly number[], report?: ReportIssue) {
  if (!record(value) || id(value.id) !== shopId || !text(value.name) || !Array.isArray(value.products)) {
    throw new Error(`買取チェッカーの店舗・商品一覧を確認できません: shop=${shopId}`);
  }
  const products = new Map<number, CheckerProduct>();
  const offers = new Map<string, CheckerOffer>();
  const blocked = new Set<number>();
  for (const row of value.products) {
    if (!record(row)) { exclude(report, 'エンジニア対応', '買取チェッカー', `買取チェッカーの商品形式が不正です: shop=${shopId}`); continue; }
    const conditionId = id(row.condition_id);
    if (conditionId === null || !conditionIds.includes(conditionId)) continue;
    const category = ({ 1: 'pokemon', 2: 'one_piece' } as Record<number, string>)[Number(row.category_id)];
    if (!category) continue;
    if (row.ask_flag === true || row.ask_flag === 1 || row.ask_flag === '1') continue;
    const productId = id(row.product_id);
    const name = text(row.name);
    const editionId = row.edition_id == null || row.edition_id === '' || row.edition_id === 0 || row.edition_id === '0'
      ? 0 : id(row.edition_id);
    const price = typeof row.buy_price === 'number' || (typeof row.buy_price === 'string' && row.buy_price.trim())
      ? Number(row.buy_price) : NaN;
    // The shop endpoint includes unavailable cards with null or zero prices.
    if (row.buy_price === null || row.buy_price === 0
      || (typeof row.buy_price === 'string' && /^0(?:\.0+)?$/.test(row.buy_price))) continue;
    if (productId === null || !name || editionId === null
      || !Number.isSafeInteger(price) || price <= 0 || price > 100_000_000) {
      if (productId !== null) blocked.add(productId);
      exclude(report, 'エンジニア対応', name ?? String(productId), `買取チェッカーの商品・価格が不正です: shop=${shopId}`);
      continue;
    }
    const product: CheckerProduct = { source_product_id: productId, category, name, full_name: text(row.full_name),
      model_number: text(row.model_number), image_url: text(row.image_url),
      rarity: text(row.rarity), holo_type: text(row.holo_type), aspect: text(row.aspect) };
    const previous = products.get(productId);
    if (previous && (previous.name !== name || previous.category !== category || previous.model_number !== product.model_number
      || previous.rarity !== product.rarity || previous.holo_type !== product.holo_type || previous.aspect !== product.aspect)) {
      blocked.add(productId);
      exclude(report, 'エンジニア対応', name, `買取チェッカーの商品情報が重複しています: shop=${shopId}, product=${productId}`);
      continue;
    }
    products.set(productId, product);
    const offer: CheckerOffer = { source_product_id: productId, shop_id: shopId, shop_name: text(value.name)!, condition_id: conditionId,
      edition_id: editionId, edition_name: text(row.edition_name), buy_price: price,
      source_updated_at: updatedAt(row.price_updated_at) };
    const key = `${productId}:${conditionId}:${editionId}`;
    const previousOffer = offers.get(key);
    if (previousOffer && JSON.stringify(previousOffer) !== JSON.stringify(offer)) {
      blocked.add(productId);
      exclude(report, 'エンジニア対応', name, `買取チェッカーの価格が重複しています: shop=${shopId}, product=${productId}`);
      continue;
    }
    offers.set(key, offer);
  }
  return { products: [...products.values()].filter(row => !blocked.has(row.source_product_id)), offers: [...offers.values()].filter(row => !blocked.has(row.source_product_id)), receivedCount: value.products.length, shopName: text(value.name)! };
}

async function fetchShop(shopId: number, conditions: readonly number[], secret: string, report?: ReportIssue) {
  for (let attempt = 0; ; attempt++) {
    // A retry may cross the signing minute, so never reuse the previous signature.
    const bucket = Math.floor(Date.now() / 60_000).toString();
    const signature = createHmac('sha256', secret).update(secret + bucket).digest('hex');
    let response: Response;
    try {
      response = await fetchWithRetry(`${KAITORI_CHECKER_API_BASE}/api/shops/${shopId}`, {
        headers: { Accept: 'application/json', 'X-APP-SIGN': signature }, redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      }, { maxRetries: 0, timeoutMs: 15_000 });
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (response.ok) return parseCheckerShop(await response.json(), shopId, conditions, report);
    if (attempt >= 2 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`買取チェッカーの店舗価格取得失敗: shop=${shopId}, HTTP ${response.status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

/** Fetch only the shops consumed by this store; never walk the global product catalog. */
export async function fetchCheckerShops(shopIds: readonly number[], conditionIds: readonly number[], report?: ReportIssue) {
  const shops = [...new Set(shopIds)].sort((a, b) => a - b);
  const conditions = [...new Set(conditionIds)].sort((a, b) => a - b);
  if (!shops.length || !conditions.length || [...shops, ...conditions].some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('買取チェッカーの参照店舗・商品区分が未設定です');
  }
  const secret = process.env.KAITORI_CHECKER_APP_SECRET?.trim() || (await getSecret('kaitori-checker-app-secret')).trim();
  if (!secret) throw new Error('買取チェッカーの認証設定がありません');
  const products = new Map<number, CheckerProduct>();
  const blocked = new Set<number>();
  const offers: CheckerOffer[] = [];
  const reports: { shop_id: number; shop_name: string | null; received_count: number; offer_count: number; error: string | null }[] = [];
  // Three concurrent requests keep generation fast without bursting at every shop.
  for (let offset = 0; offset < shops.length; offset += 3) {
    const batch = shops.slice(offset, offset + 3);
    const results = await Promise.allSettled(batch.map(shopId => fetchShop(shopId, conditions, secret, report)));
    for (const [index, response] of results.entries()) {
      const shopId = batch[index];
      if (response.status === 'rejected') {
        const error = response.reason instanceof Error ? response.reason.message : String(response.reason);
        reports.push({ shop_id: shopId, shop_name: null, received_count: 0, offer_count: 0, error });
        report?.('エンジニア対応', '買取チェッカー 店舗 ' + shopId, error);
        console.warn(`[checker-shops] shop=${shopId}: ${error}`);
        continue;
      }
      const result = response.value;
      for (const product of result.products) {
        const previous = products.get(product.source_product_id);
        if (previous && (previous.category !== product.category || previous.name !== product.name
          || previous.model_number !== product.model_number || previous.rarity !== product.rarity
          || previous.holo_type !== product.holo_type || previous.aspect !== product.aspect)) {
          blocked.add(product.source_product_id);
          exclude(report, 'エンジニア対応', product.name, '買取チェッカーの店舗間の商品情報が一致しません: product=' + product.source_product_id);
          continue;
        }
        products.set(product.source_product_id, previous ?? product);
      }
      offers.push(...result.offers);
      reports.push({ shop_id: shopId, shop_name: result.shopName, received_count: result.receivedCount,
        offer_count: result.offers.length, error: null });
    }
  }
  if (!report && reports.every(report => report.error !== null)) {
    throw new Error(`買取チェッカーの参照店舗を取得できません: ${reports.map(report => report.error).join('; ')}`);
  }
  for (const productId of blocked) products.delete(productId);
  const eligible = offers.filter(offer => !blocked.has(offer.source_product_id));
  return { products: [...products.values()], offers: eligible, report: { api_base: KAITORI_CHECKER_API_BASE,
    shop_ids: shops, condition_ids: conditions, fetched_at: new Date().toISOString(),
    product_count: products.size, offer_count: eligible.length, shops: reports } };
}
