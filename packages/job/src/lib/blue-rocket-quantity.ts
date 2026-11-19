import { postalProductIdentity } from '@haraka/shared';
import { blueRocketCardName, blueRocketModelNumber } from './blue-rocket.js';
import { fetchWithRetry } from './fetch-with-retry.js';

// The official /prices/stores list has no postal store. Never map Suehirocho to postal shop 44.
const STORES = [{ shopId: 11, code: 'akihabara' }, { shopId: 51, code: 'laox' },
  { shopId: 54, code: 'osaka' }, { shopId: 55, code: 'fukuoka' }] as const;
export type BlueRocketQuantityQuote = { shopId: number; identity: string | null; price: number;
  singleQuantity: boolean; productId: number; modelKey?: string };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0;

/** Quantity describes this exact public quote, not every variant with the same card number. */
export function parseBlueRocketQuantityQuotes(payload: unknown, shopId: number, code: string,
  businessDate: string, maxAgeDays: number): BlueRocketQuantityQuote[] {
  if (!record(payload) || payload.storeId !== code || payload.storeCode !== code || !Array.isArray(payload.items)
    || typeof payload.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.businessDate)) {
    throw new Error('ブルーロケット募集数APIの店舗・営業日・データ形式を確認できません');
  }
  const observed = Date.parse(`${payload.businessDate}T00:00:00Z`);
  const age = (Date.parse(`${businessDate}T00:00:00Z`) - observed) / 86_400_000;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeDays
    || new Date(observed).toISOString().slice(0, 10) !== payload.businessDate) {
    throw new Error(`ブルーロケット募集数APIの営業日が許容範囲外です: ${payload.businessDate}`);
  }
  const quotes: BlueRocketQuantityQuote[] = [];
  for (const item of payload.items) {
    if (!record(item) || typeof item.productId !== 'number' || !Number.isSafeInteger(item.productId)
      || typeof item.name !== 'string'
      || typeof item.cardNumber !== 'string' || !positiveInteger(item.price) || item.price > 100_000_000
      || item.status !== 'available' || (item.remainingQty !== null && !positiveInteger(item.remainingQty))
      || (item.kind !== null && item.kind !== 'graded')) continue;
    const label = item.name.normalize('NFKC').trim();
    const prefix = /^PSA\s*10(?![\d.])\s*/i;
    const grade = typeof item.gradeLabel === 'string'
      ? item.gradeLabel.normalize('NFKC').replace(/\s+/g, '').toUpperCase() : null;
    if (grade !== null && grade !== 'PSA10') continue;
    if (!prefix.test(label) && (grade !== 'PSA10' || /^PSA\s*\d/i.test(label))) continue;
    const onePieceModel = /^(?:(?:OP|ST|EB|PRB)\d{2,3}|P)-\d{2,3}$/i.test(item.cardNumber.normalize('NFKC').trim());
    const franchise = item.genre === 'pokemon' ? 'Pokemon' : item.genre === 'onepiece'
      || (item.genre == null && onePieceModel) ? 'ONE PIECE' : null;
    if (!franchise) continue;
    const rawName = label.replace(prefix, '');
    let name: string | null;
    let modelNumber: string | null;
    if (franchise === 'Pokemon') {
      name = blueRocketCardName(rawName);
      modelNumber = blueRocketModelNumber(item.cardNumber);
    } else {
      modelNumber = item.cardNumber.normalize('NFKC').trim();
      if (!/^(?:(?:OP|ST|EB|PRB)\d{2,3}|P)-\d{2,3}$/i.test(modelNumber)) continue;
      // Keep other designs as model/price evidence without inventing an exact name match.
      const head = rawName.split('[')[0].trim();
      name = /\(コミパラ\)$/.test(head) ? head.split(/\s+/)[0] + '(パラレル/漫画背景/漫画絵)' : null;
    }
    if (!modelNumber) continue;
    const boostedSingle = record(item.boost) && item.boost.remainingQty === 1;
    quotes.push({ shopId, productId: item.productId, price: item.price,
      identity: name ? postalProductIdentity({ franchise, name, modelNumber, productType: 'PSA10' }) : null,
      modelKey: blueRocketModelQuantityKey(shopId, franchise, modelNumber, blueRocketCardName(rawName), item.price),
      singleQuantity: item.remainingQty === 1 || boostedSingle });
  }
  return quotes;
}

export function blueRocketQuantityKey(quote: Pick<BlueRocketQuantityQuote, 'shopId' | 'identity' | 'price'>): string {
  return JSON.stringify([quote.shopId, quote.identity, quote.price]);
}

export function blueRocketModelQuantityKey(shopId: number, franchise: string, modelNumber: string, name: string, price: number): string {
  const baseName = name.normalize('NFKC').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, '').replace(/\s+/g, '');
  return JSON.stringify([shopId, franchise, modelNumber.normalize('NFKC').toLowerCase().replace(/\s+/g, ''), baseName, price]);
}

/** Conflicting public rows cannot prove that an exact quote is limited to one card. */
export function blueRocketSingleQuantityKeys(quotes: BlueRocketQuantityQuote[], matchModel = false): Set<string> {
  const groups = new Map<string, boolean>();
  for (const quote of quotes) {
    const key = matchModel ? quote.modelKey : quote.identity ? blueRocketQuantityKey(quote) : undefined;
    if (!key) continue;
    groups.set(key, (groups.get(key) ?? true) && quote.singleQuantity);
  }
  return new Set([...groups].filter(([, single]) => single).map(([key]) => key));
}

export async function fetchBlueRocketQuantityQuotes(businessDate: string, maxAgeDays: number) {
  const results = await Promise.allSettled(STORES.map(async store => {
    const response = await fetchWithRetry(`https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=${store.code}`, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, redirect: 'error',
    }, { timeoutMs: 10_000, maxRetries: 1, baseDelayMs: 500 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseBlueRocketQuantityQuotes(await response.json(), store.shopId, store.code, businessDate, maxAgeDays);
  }));
  const quotes: BlueRocketQuantityQuote[] = [];
  const shops = results.map((result, index) => {
    if (result.status === 'fulfilled') quotes.push(...result.value);
    return { shop_id: STORES[index].shopId, store_code: STORES[index].code,
      parsed_quote_count: result.status === 'fulfilled' ? result.value.length : 0,
      error: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : null };
  });
  return { quotes, report: { shops, quantity_unavailable_shop_ids: [44] } };
}
