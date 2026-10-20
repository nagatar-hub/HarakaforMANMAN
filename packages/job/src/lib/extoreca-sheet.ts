import { isBuiltInOrderListExclusion, postalProductIdentity } from '@haraka/shared';
import { blueRocketModelNumber } from './blue-rocket.js';
import { fetchWithRetry } from './fetch-with-retry.js';
import { parseCsv } from './public-csv-sheet.js';

const SHEET_ID = '1you9cwtDUuNSu4QHuwMK-4vZP_4V-3mWW7uJvKFa31s';
export const EXTORECA_BOX_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;
export const EXTORECA_PSA_SHEET_URL =
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=1475300317`;

export type ExtorecaRow = {
  id: string;
  name: string;
  modelNumber: string | null;
  price: number;
  productType: 'BOX' | 'PSA10';
};

const requiredHeaders = ['商品名', 'レアリティ', '識別番号', '希望卸金額(エクス)'] as const;
const header = (value: string) => value.replace(/^\uFEFF/, '').normalize('NFKC').replace(/\s+/g, '').trim();

function schema(rows: string[][]): { row: number; columns: Record<(typeof requiredHeaders)[number], number> } {
  const matches = rows.flatMap((values, row) => {
    const normalized = values.map(header);
    return requiredHeaders.every(name => normalized.includes(name)) ? [{ row, normalized }] : [];
  });
  if (matches.length !== 1) throw new Error(`エクストレカ買取表のヘッダーが${matches.length ? '曖昧です' : '見つかりません'}`);
  const columns = {} as Record<(typeof requiredHeaders)[number], number>;
  for (const name of requiredHeaders) {
    const indexes = matches[0].normalized.flatMap((value, index) => value === name ? [index] : []);
    if (indexes.length !== 1) throw new Error(`エクストレカ買取表の「${name}」列が曖昧です`);
    columns[name] = indexes[0];
  }
  return { row: matches[0].row, columns };
}

export function parseExtorecaSheet(csv: string, productType: 'BOX' | 'PSA10'): ExtorecaRow[] {
  const rows = parseCsv(csv);
  const { row: headerRow, columns } = schema(rows);
  const unique = new Map<string, ExtorecaRow | null>();
  rows.slice(headerRow + 1).forEach((values, index) => {
    const name = (values[columns['商品名']] ?? '').normalize('NFKC').trim();
    const price = Number((values[columns['希望卸金額(エクス)']] ?? '').normalize('NFKC').replace(/[,¥￥円\s]/g, ''));
    const modelNumber = productType === 'PSA10'
      ? blueRocketModelNumber(values[columns['識別番号']] ?? '')
      : null;
    if (!name || /^例(?:\)|:|\/)/.test(name) || /^※|^注意[:：]?/.test(name) || isBuiltInOrderListExclusion(name)
      || !Number.isSafeInteger(price) || price <= 0 || price > 100_000_000
      || (productType === 'PSA10' && !modelNumber)) return;
    const identity = postalProductIdentity({ franchise: 'Pokemon', name, modelNumber, productType });
    const current = unique.get(identity);
    const parsed = {
      id: `sheet:${productType.toLowerCase()}:${headerRow + index + 2}`,
      name, modelNumber, price, productType,
    };
    if (current === undefined) unique.set(identity, parsed);
    else if (current?.price !== price) unique.set(identity, null);
  });
  return [...unique.values()].filter((row): row is ExtorecaRow => row !== null);
}

type LineupCard = { franchise: string; name: string; modelNumber: string | null; productType: 'PSA10' | 'BOX' };

export function extorecaPsaCandidates(rows: ExtorecaRow[], lineup: LineupCard[]) {
  const psa = lineup.filter(card => card.franchise === 'Pokemon' && card.productType === 'PSA10' && card.modelNumber);
  const identities = new Set(psa.map(card => postalProductIdentity(card)));
  const model = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const models = new Set(psa.map(card => model(card.modelNumber!)));
  const used: ExtorecaRow[] = [];
  const skipped: Pick<ExtorecaRow, 'name' | 'modelNumber' | 'price'>[] = [];
  for (const row of rows) {
    const identity = postalProductIdentity({ franchise: 'Pokemon', name: row.name,
      modelNumber: row.modelNumber, productType: 'PSA10' });
    if (identities.has(identity) || !models.has(model(row.modelNumber!))) used.push(row);
    else skipped.push({ name: row.name, modelNumber: row.modelNumber, price: row.price });
  }
  return { used, skipped };
}

async function fetchSheet(url: string, productType: 'BOX' | 'PSA10'): Promise<ExtorecaRow[]> {
  const response = await fetchWithRetry(url, { method: 'GET' }, { timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`エクストレカ${productType}表の取得失敗: HTTP ${response.status}`);
  const rows = parseExtorecaSheet(await response.text(), productType);
  if (productType === 'BOX' && !rows.length) throw new Error('エクストレカBOX表に価格行がありません');
  return rows;
}

export const fetchExtorecaBoxSheet = (url = EXTORECA_BOX_SHEET_URL) => fetchSheet(url, 'BOX');
export const fetchExtorecaPsaSheet = (url = EXTORECA_PSA_SHEET_URL) => fetchSheet(url, 'PSA10');
