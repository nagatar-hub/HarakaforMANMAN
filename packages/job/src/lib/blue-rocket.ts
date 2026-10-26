import { postalProductIdentity } from '@haraka/shared';
import { fetchWithRetry } from './fetch-with-retry.js';

/** ブルーロケットの公開買取API。東京満満では従来どおりポケカPSA10だけを比較に使う。 */
export const BLUE_ROCKET_PRICES_API_URL =
  'https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=laox';
export const BLUE_ROCKET_AKIHABARA_PRICES_API_URL =
  'https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=akihabara';

export type BlueRocketStore = 'laox' | 'akihabara';

export type BlueRocketPsaRow = {
  id: string;
  name: string;
  modelNumber: string;
  price: number;
  imageUrl: string | null;
};

export type BlueRocketPsaPrices = {
  storeId: BlueRocketStore;
  businessDate: string;
  fetchedAt: string;
  itemCount: number;
  rows: BlueRocketPsaRow[];
};

/**
 * 「Nのゾロアークex SAR [M2a 242/193](...)」「MレックウザEX: プロモ[...]」「ミュウ ふしぎなしっぽ」
 * 「ピカチュウVMAX（バンザイピカチュウ）」から名前だけを取り出す。レアリティや補足は空白の後ろに付くため、
 * 最初の空白より前を名前とする（カードの特定は型番と合わせて行う）。
 */
export function blueRocketCardName(label: string): string {
  const text = label.normalize('NFKC');
  const name = text.split('[')[0]
    .replace(/\s*:.*$/, '')
    .replace(/\s*\([^)]*[^\x00-\x7f][^)]*\)\s*$/, match => (/^\s*\((?:25th|sa|フラッグシップ)\)/i.test(match) ? match : ''))
    .trim()
    .split(/\s+/)[0];
  // 言語違い・1ED・エラー版は別カード。名前に残さないと日本語版・通常版として掲載されてしまう。
  const variants = [/【中国語版】/.test(text) && '(中国語版)', /:\s*1ED\b/i.test(text) && '(1ED)', /エラー版/.test(text) && '(エラー版)',
    /マスターボールミラー/.test(text) && '(マスターボールミラー)',
    /モンスターボールミラー/.test(text) && '(モンスターボールミラー)'];
  return name && name + variants.filter((variant): variant is string => !!variant && !name.includes(variant)).join('');
}

/** 「062/SV/P」を「062/SV-P」にそろえ、「085」「0307/07」のような型番として成り立たない値は捨てる。 */
export function blueRocketModelNumber(value: string): string | null {
  const model = value.normalize('NFKC').trim().replace(/^(\d+)\/([A-Za-z]+)\/P$/, '$1/$2-P');
  return /^\d{2,3}\/[A-Za-z0-9-]+$/.test(model) ? model : null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** APIは他作品・素体・停止中の価格も含み得るので、掲載可能なポケカPSA10だけに絞る。 */
export function parseBlueRocketPsaPrices(payload: unknown, store: BlueRocketStore = 'laox'): BlueRocketPsaPrices {
  if (!record(payload) || payload.storeId !== store || payload.storeCode !== store
    || !validBusinessDate(payload.businessDate) || typeof payload.fetchedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(payload.fetchedAt)
    || !Number.isFinite(Date.parse(payload.fetchedAt)) || !Array.isArray(payload.items)) {
    throw new Error('ブルーロケット買取APIの店舗・営業日・データ形式を確認できません');
  }
  const best = new Map<string, BlueRocketPsaRow>();
  for (const item of payload.items) {
    if (!record(item) || typeof item.name !== 'string' || typeof item.cardNumber !== 'string'
      || !Number.isSafeInteger(item.productId) || (item.productId as number) <= 0
      || typeof item.price !== 'number' || !Number.isSafeInteger(item.price)
      || item.price <= 0 || item.price > 100_000_000 || item.status !== 'available'
      || (item.remainingQty !== null && (typeof item.remainingQty !== 'number'
        || !Number.isSafeInteger(item.remainingQty) || item.remainingQty <= 0))
      || (item.kind !== null && item.kind !== 'graded')) continue;
    const label = item.name.normalize('NFKC').trim();
    // 数字型番のワンピース（例: ST003/008）もあるため、型番の形だけでポケカと判定しない。
    if (/\b(?:OP|ST|EB|PRB)\d{2,3}[-/]\d{2,3}\b/i.test(`${label} ${item.cardNumber}`)
      || /ワンピース|ONE\s*PIECE/i.test(label)) continue;
    const prefix = /^PSA\s*10(?![\d.])\s*/i;
    const grade = typeof item.gradeLabel === 'string'
      ? item.gradeLabel.normalize('NFKC').replace(/\s+/g, '').toUpperCase() : null;
    if (grade !== null && grade !== 'PSA10') continue;
    if (!prefix.test(label) && (grade !== 'PSA10' || /^PSA\s*\d/i.test(label))) continue;
    const name = blueRocketCardName(label.replace(prefix, ''));
    const modelNumber = blueRocketModelNumber(item.cardNumber);
    if (!name || !modelNumber) continue;
    const imageUrl = typeof item.imageUrl === 'string' && /^https:\/\//.test(item.imageUrl) ? item.imageUrl : null;
    // 同じカードが複数行あれば高い方だけを残す（同一ソース内の重複で比較が「曖昧」扱いにならないよう）。
    const key = postalProductIdentity({ franchise: 'Pokemon', name, modelNumber, productType: 'PSA10' });
    const current = best.get(key);
    if (!current || item.price > current.price) best.set(key, {
      id: `api:${store}:${item.productId}`, name, modelNumber, price: item.price, imageUrl,
    });
  }
  return { storeId: store, businessDate: payload.businessDate, fetchedAt: payload.fetchedAt,
    itemCount: payload.items.length, rows: [...best.values()] };
}

type LineupCard = { franchise: string; name: string; modelNumber: string | null; productType: 'PSA10' | 'BOX' };

/**
 * ブルーロケットの行を比較候補にする。KECAK・シンソクに同じ型番の商品があるのに名前が一致しない行は、
 * 「ピカチュウ【P】」「ピカチュウ(中国語版)」のように同一か別版か判断できないため使わない（二重掲載を防ぐ）。
 * 同じ型番の商品が無い行はブルーロケットだけの商品として掲載候補にする。
 */
export function blueRocketPsaCandidates(rows: BlueRocketPsaRow[], lineup: LineupCard[]) {
  const psa = lineup.filter(card => card.franchise === 'Pokemon' && card.productType === 'PSA10' && card.modelNumber);
  const identities = new Set(psa.map(card => postalProductIdentity(card)));
  const model = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const models = new Set(psa.map(card => model(card.modelNumber!)));
  const used: BlueRocketPsaRow[] = [];
  const skipped: { name: string; modelNumber: string; price: number }[] = [];
  for (const row of rows) {
    const identity = postalProductIdentity({ franchise: 'Pokemon', name: row.name, modelNumber: row.modelNumber, productType: 'PSA10' });
    if (identities.has(identity) || !models.has(model(row.modelNumber))) used.push(row);
    else skipped.push({ name: row.name, modelNumber: row.modelNumber, price: row.price });
  }
  return { used, skipped };
}

export async function fetchBlueRocketPsaPrices(store: BlueRocketStore = 'laox'): Promise<BlueRocketPsaPrices> {
  const url = store === 'laox' ? BLUE_ROCKET_PRICES_API_URL : BLUE_ROCKET_AKIHABARA_PRICES_API_URL;
  const response = await fetchWithRetry(url, {
    method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  }, { timeoutMs: 10_000, maxRetries: 1, baseDelayMs: 500 });
  if (!response.ok) throw new Error(`ブルーロケット買取APIの取得失敗: HTTP ${response.status}`);
  return parseBlueRocketPsaPrices(await response.json(), store);
}
