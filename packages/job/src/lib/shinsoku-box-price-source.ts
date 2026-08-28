import {
  normalizeText, calculateBoxPriceHigh, calculateBoxPrice, calculatePelekaAlignedBuyPriceRange,
  type Database, type Franchise, type PreparedCardRow, type StorePricingSettings,
} from '@haraka/shared';
import { isBoxRow } from './box-row.js';
import { fetchSheetValues } from './google-sheets.js';
import { getOptionalEnvOrSecret } from './env.js';

type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];

const BOX_TYPE = 'BOX';
const PRODUCT_NAME_COL = 1;
const BUY_PRICE_COL = 3;
const SOURCE_FRANCHISES: Record<string, Franchise> = {
  'ポケモン': 'Pokemon', 'ワンピース': 'ONE PIECE', '遊戯王': 'YU-GI-OH!',
  DB: 'DRAGON BALL', 'ヴァイスシュヴァルツ': 'WEISS SCHWARZ',
};
const BOX_PRICE_PRODUCT_PREFIX_RE = /^(?:ポケモンカードゲーム|ポケモンカードゲームスカーレット＆バイオレット|スカーレット＆バイオレット|ソード＆シールド)?(?:強化拡張パック|拡張パック|ハイクラスパック|スターターセットex|スターターセット|スターターデッキ＆ビルドセット|プレミアムトレーナーボックスex|デッキビルドBOX)/;

function safeNumber(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.normalize('NFKC').replace(/[¥￥$,、円\s]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

export function normalizeShinsokuBoxProductName(value: string): string {
  let productName = normalizeText(value)
    .normalize('NFKC')
    .replace(/^\s*[\[【]\s*1?\s*box\s*[\]】]\s*/i, '')
    .replace(/\s+(?:fb|sb|op|eb|prb|st)-?\d+\s*$/i, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/\([a-z0-9+&/\-]+\)$/i, '')
    .trim();

  const isDeluxe = productName.includes('デラックス');
  const quotedName = productName.match(BOX_PRICE_PRODUCT_PREFIX_RE)?.[0]
    ? productName.match(/「([^」]+)」/)?.[1]
    : null;
  if (quotedName) productName = quotedName;

  const normalized = productName.toLowerCase().replaceAll('é', 'e');
  const identity = normalized
    .replaceAll('ポケットモンスターカードゲーム', '')
    .replaceAll('ポケモンカードゲーム', '')
    .replace(/(強化拡張パック|拡張パックデラックス|拡張パック|コンセプトパック|ハイクラスパック|ムービースペシャルパック)/g, '')
    .replace(/第[0-9]+弾/g, '')
    .replaceAll('デラックス', '')
    .replace(/(?:anniversary|アニバーサリー)/g, '')
    .replaceAll('ゴールデン', 'golden')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .replace(/^tagteamgx/, '')
    .replace(/イチゴーイチ$/, '')
    .replace(/(?:box|ボックス)$/, '')
    .replaceAll('vスター', 'vstar');
  return isDeluxe ? `${identity}|deluxe` : identity;
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

function priceKey(franchise: string, name: string): string {
  return franchise === 'Pokemon' ? name : `${franchise}:${name}`;
}

export function parseShinsokuBoxPriceRows(rows: string[][]): Map<string, number> {
  const priceMap = new Map<string, number>();
  const ambiguousKeys = new Set<string>();
  const brandColumn = rows[0]?.indexOf('ブランド') ?? -1;

  for (const row of rows.slice(1)) {
    if (normalizeText(row[0] ?? '') !== BOX_TYPE) continue;

    const rawProductName = normalizeText(row[PRODUCT_NAME_COL] ?? '');
    const productName = normalizeShinsokuBoxProductName(rawProductName);
    if (!rawProductName || !productName) continue;
    const brand = brandColumn < 0 ? 'ポケモン' : row[brandColumn]?.trim() || 'ポケモン';
    const franchise = SOURCE_FRANCHISES[brand];
    if (!franchise) throw new Error(`Unsupported Shinsoku brand: ${brand}`);

    if (!(row[BUY_PRICE_COL] ?? '').trim()) continue;
    const price = safeNumber(row[BUY_PRICE_COL]);
    if (price == null || !Number.isSafeInteger(price) || price < 0) {
      throw new Error(`Shinsoku BOX price is invalid: ${rawProductName}`);
    }
    if (price === 0) continue;

    setUniquePrice(priceMap, ambiguousKeys, priceKey(franchise, rawProductName), price);
    setUniquePrice(priceMap, ambiguousKeys, priceKey(franchise, productName), price);
  }

  return priceMap;
}

export function applyShinsokuBoxPriceOverrides(
  rows: RawImportInsert[],
  priceMap: Map<string, number>,
): { rows: RawImportInsert[]; missingNames: string[] } {
  const missingNames: string[] = [];

  const overriddenRows = rows.map((row) => {
    if (!isBoxRow(row)) return row;

    const productName = normalizeShinsokuBoxProductName(row.card_name);
    const price = priceMap.get(priceKey(row.franchise, productName));
    const usesOrderListPrice = row.price_source === 'order_list';
    const originalPriceMetadata = usesOrderListPrice
      ? { pokemon_box_original_order_list_price: row.source_price }
      : { pokemon_box_original_kecak_price: row.kecak_price };
    if (price == null) {
      missingNames.push(productName);
      return {
        ...row,
        source_price: null,
        kecak_price: null,
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

export async function loadShinsokuBoxPriceMap(accessToken: string): Promise<Map<string, number>> {
  // 既存の設定キーを保持し、同じDatabaseシートの全商材を読む。
  const spreadsheetId = await getOptionalEnvOrSecret('POKEMON_BOX_SPREADSHEET_ID')
    ?? '1xxIJ0Rbi90I_Bd2FhGVcu3cdlAcVAxl0x6wk5913vWw';
  const rows = await fetchSheetValues({ accessToken, spreadsheetId, range: 'Database' });
  const prices = parseShinsokuBoxPriceRows(rows);
  const brandColumn = rows[0]?.indexOf('ブランド') ?? -1;
  const pokemonCount = rows.slice(1).filter(row =>
    normalizeText(row[0] ?? '') === BOX_TYPE
    && (brandColumn < 0 || !row[brandColumn]?.trim() || row[brandColumn]?.trim() === 'ポケモン')
    && (safeNumber(row[BUY_PRICE_COL]) ?? 0) > 0,
  ).length;
  if (rows.length - 1 < 150 || rows.length - 1 > 4000 || pokemonCount < 160) {
    throw new Error(`Incomplete Shinsoku snapshot: rows=${rows.length - 1}, Pokemon BOX=${pokemonCount}`);
  }
  if (!prices.size) throw new Error('シンソクBOX価格がありません');
  return prices;
}

export function applyCurrentShinsokuBoxPrices<T extends Pick<PreparedCardRow,
  'card_name' | 'franchise' | 'grade' | 'price_high'
>>(cards: T[], prices: Map<string, number>, settings: StorePricingSettings): T[] {
  return cards.map(card => {
    if (!isBoxRow(card)) return card;
    const sourcePrice = prices.get(priceKey(card.franchise, normalizeShinsokuBoxProductName(card.card_name)));
    if (sourcePrice == null) return { ...card, price_high: 0 };
    const franchise = card.franchise as Franchise;
    const rates = settings.box_discount_rates[franchise];
    return {
      ...card,
      price_high: calculateBoxPriceHigh(sourcePrice, rates.shrink),
      ...('price_low' in card ? {
        price_low: franchise === 'WEISS SCHWARZ' || franchise === 'DRAGON BALL'
          ? calculatePelekaAlignedBuyPriceRange(sourcePrice).lower
          : calculateBoxPrice(sourcePrice, rates.no_shrink),
      } : {}),
    };
  });
}
