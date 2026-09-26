import { postalProductIdentity } from '@haraka/shared';
import { fetchWithRetry } from './fetch-with-retry.js';

/** ブルーロケットの公開買取表「ポケカPSA強化買取リスト」。東京満満の PSA10 比較に使う。 */
export const BLUE_ROCKET_PSA_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1rdPQoWi2MeQxHxQDuKVMiG_HWeHz71dJMtA6ImNd8sE/gviz/tq?tqx=out:csv&gid=1335557591';

export type BlueRocketPsaRow = {
  id: string;
  name: string;
  modelNumber: string;
  price: number;
  imageUrl: string | null;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

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
  const variants = [/【中国語版】/.test(text) && '(中国語版)', /:\s*1ED\b/i.test(text) && '(1ED)', /エラー版/.test(text) && '(エラー版)'];
  return name && name + variants.filter(Boolean).join('');
}

/** 「062/SV/P」を「062/SV-P」にそろえ、「085」「0307/07」のような型番として成り立たない値は捨てる。 */
export function blueRocketModelNumber(value: string): string | null {
  const model = value.normalize('NFKC').trim().replace(/^(\d+)\/([A-Za-z]+)\/P$/, '$1/$2-P');
  return /^\d{2,3}\/[A-Za-z0-9-]+$/.test(model) ? model : null;
}

/** 列: [注記, 金額, 枚数, カード名, 型番, (空), 画像URL, ...]。金額・名前・型番が揃う行だけを使う。 */
export function parseBlueRocketPsaSheet(csv: string): BlueRocketPsaRow[] {
  const best = new Map<string, BlueRocketPsaRow>();
  parseCsv(csv).slice(1).forEach((cols, index) => {
    const price = Number((cols[1] ?? '').replace(/[,¥￥円\s]/g, ''));
    const name = blueRocketCardName(cols[3] ?? '');
    const modelNumber = blueRocketModelNumber(cols[4] ?? '');
    if (!Number.isSafeInteger(price) || price <= 0 || !name || !modelNumber) return;
    const imageUrl = /^https:\/\//.test(cols[6] ?? '') ? cols[6] : null;
    // 同じカードが複数行あれば高い方だけを残す（同一ソース内の重複で比較が「曖昧」扱いにならないよう）。
    const key = postalProductIdentity({ franchise: 'Pokemon', name, modelNumber, productType: 'PSA10' });
    const current = best.get(key);
    if (!current || price > current.price) best.set(key, { id: `sheet:${index + 2}`, name, modelNumber, price, imageUrl });
  });
  return [...best.values()];
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

export async function fetchBlueRocketPsaSheet(url = BLUE_ROCKET_PSA_SHEET_URL): Promise<BlueRocketPsaRow[]> {
  const response = await fetchWithRetry(url, { method: 'GET' }, { timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`ブルーロケット買取表の取得失敗: HTTP ${response.status}`);
  const rows = parseBlueRocketPsaSheet(await response.text());
  if (!rows.length) throw new Error('ブルーロケット買取表に価格行がありません');
  return rows;
}
