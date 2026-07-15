import { normalizeText, type Database } from '@haraka/shared';
import { isBoxRow } from './box-row.js';

type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];

const BOX_TYPE = 'BOX';
const PRODUCT_NAME_COL = 1;
const BUY_PRICE_COL = 3;
const BOX_PRICE_PRODUCT_PREFIX_RE = /^(?:ポケモンカードゲーム|ポケモンカードゲームスカーレット＆バイオレット|スカーレット＆バイオレット|ソード＆シールド)?(?:強化拡張パック|拡張パック|ハイクラスパック|スターターセットex|スターターセット|スターターデッキ＆ビルドセット|プレミアムトレーナーボックスex|デッキビルドBOX)/;

function safeNumber(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replace(/[¥￥$,、\s]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function normalizePokemonBoxProductName(value: string): string {
  let productName = normalizeText(value)
    .replace(/【\s*BOX\s*】/gi, '')
    .replace(/^\[\s*1?\s*BOX\s*\]/i, '')
    .replace(/[ 　\t\r\n]/g, '')
    .trim();

  productName = productName.replace(/[（(][A-Z0-9a-z＋+&/\-]+[）)]$/g, '');

  const quotedName = productName.match(BOX_PRICE_PRODUCT_PREFIX_RE)?.[0]
    ? productName.match(/「([^」]+)」/)?.[1]
    : null;
  if (quotedName) return normalizePokemonBoxProductName(quotedName);

  return productName;
}

function setUniquePrice(
  priceMap: Map<string, number>,
  ambiguousKeys: Set<string>,
  key: string,
  price: number,
): void {
  if (!key || ambiguousKeys.has(key)) return;

  const existingPrice = priceMap.get(key);
  if (existingPrice == null || existingPrice === price) {
    priceMap.set(key, price);
    return;
  }

  priceMap.delete(key);
  ambiguousKeys.add(key);
}

export function parsePokemonBoxPriceRows(rows: string[][]): Map<string, number> {
  const priceMap = new Map<string, number>();
  const ambiguousKeys = new Set<string>();

  for (const row of rows.slice(1)) {
    if (normalizeText(row[0] ?? '') !== BOX_TYPE) continue;

    const rawProductName = normalizeText(row[PRODUCT_NAME_COL] ?? '');
    const productName = normalizePokemonBoxProductName(rawProductName);
    if (!rawProductName || !productName) continue;

    const price = safeNumber(row[BUY_PRICE_COL]);
    if (price == null || price <= 0) continue;

    setUniquePrice(priceMap, ambiguousKeys, rawProductName, price);
    setUniquePrice(priceMap, ambiguousKeys, productName, price);
  }

  return priceMap;
}

function isPokemonBoxRawImport(row: RawImportInsert): boolean {
  return row.franchise === 'Pokemon' && isBoxRow(row);
}

export function applyPokemonBoxPriceOverrides(
  rows: RawImportInsert[],
  priceMap: Map<string, number>,
): { rows: RawImportInsert[]; missingNames: string[] } {
  const missingNames: string[] = [];

  const overriddenRows = rows.map((row) => {
    if (!isPokemonBoxRawImport(row)) return row;

    const productName = normalizePokemonBoxProductName(row.card_name);
    const price = priceMap.get(productName);
    const usesOrderListPrice = row.price_source === 'order_list';
    const originalPriceMetadata = usesOrderListPrice
      ? { pokemon_box_original_order_list_price: row.source_price }
      : { pokemon_box_original_kecak_price: row.kecak_price };
    if (price == null) {
      missingNames.push(productName);
      return {
        ...row,
        ...(usesOrderListPrice ? { source_price: null } : { kecak_price: null }),
        raw_row: {
          ...(row.raw_row ?? {}),
          pokemon_box_price_source: 'missing',
          pokemon_box_price_lookup_name: productName,
          ...originalPriceMetadata,
        },
      };
    }

    return {
      ...row,
      ...(usesOrderListPrice ? { source_price: price } : { kecak_price: price }),
      raw_row: {
        ...(row.raw_row ?? {}),
        pokemon_box_price_source: 'BOX_PRICE_DB',
        pokemon_box_price_lookup_name: productName,
        ...originalPriceMetadata,
      },
    };
  });

  return { rows: overriddenRows, missingNames };
}
