/**
 * SpectreMapping シートパーサー
 *
 * Spectre（別の卸先）の TOP カードを取り込み、
 * prepared_card として登録するためのデータを生成する。
 *
 * SPECTRE_MAP_COLS (1-indexed):
 *   GROUP=1, SPECTRE_NAME=2, SPECTRE_PRICE=3, IMAGE_URL=4,
 *   HARAKA_NAME=5, HARAKA_TYPE=6, HARAKA_CARD_NO=7, BUY_PRICE=8
 */

import type { Franchise, Database, Psa10DiscountRates } from '@haraka/shared';
import {
  SPECTRE_MAP_COLS,
  normalizeText,
  calculateBuyPriceHigh,
  calculateBuyPriceLow,
  DEFAULT_PSA10_DISCOUNT_RATES,
} from '@haraka/shared';

type PreparedCardInsert = Database['public']['Tables']['prepared_card']['Insert'];

export function spectreIntersectionKey(
  franchise: string,
  listNo: string,
  grade: string | null | undefined,
): string {
  return `${franchise}\u0000${listNo}\u0000${grade ?? ''}`;
}

/**
 * セルの値を取得（1-indexed）
 */
function getCell(row: string[], colNumber: number): string {
  return row[colNumber - 1] ?? '';
}

/**
 * 文字列を数値に変換（¥記号・カンマ除去）
 */
function safeNumber(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replace(/[¥￥$,、\s]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

function calculatePriceLow(
  priceHigh: number | null,
  franchise: Franchise,
): number | null {
  if (priceHigh == null || priceHigh <= 0) return null;
  return calculateBuyPriceLow(priceHigh, franchise);
}

function resolveNonBoxDiscountRate(franchise: Franchise, psa10DiscountRates?: Psa10DiscountRates): number {
  return psa10DiscountRates?.[franchise] ?? DEFAULT_PSA10_DISCOUNT_RATES[franchise];
}

/**
 * SpectreMapping シートを解析し、PreparedCard Insert 配列を返す
 *
 * - 1行目（ヘッダ）はスキップ
 * - SPECTRE_NAME が空の行はスキップ
 * - source = 'spectre'
 * - price_high = BUY_PRICE（H列）に商材別減額率を反映
 * - price_low = calculateBuyPriceLow(price_high, franchise)
 */
export function parseSpectreRows(
  rows: string[][],
  franchise: Franchise,
  runId: string,
  psa10DiscountRates?: Psa10DiscountRates,
): PreparedCardInsert[] {
  if (rows.length <= 1) return [];

  const dataRows = rows.slice(1); // ヘッダスキップ
  const result: PreparedCardInsert[] = [];
  const nonBoxDiscountRate = resolveNonBoxDiscountRate(franchise, psa10DiscountRates);

  for (const row of dataRows) {
    const spectreName = getCell(row, SPECTRE_MAP_COLS.SPECTRE_NAME);
    if (!spectreName || spectreName.trim() === '') continue;

    const sourcePrice = safeNumber(getCell(row, SPECTRE_MAP_COLS.BUY_PRICE));
    const priceHigh = sourcePrice != null && sourcePrice > 0
      ? calculateBuyPriceHigh(sourcePrice, nonBoxDiscountRate)
      : sourcePrice;
    const grade = getCell(row, SPECTRE_MAP_COLS.HARAKA_TYPE) || null;
    const priceLow = calculatePriceLow(priceHigh, franchise);

    result.push({
      run_id: runId,
      raw_import_id: null,
      franchise,
      card_name: normalizeText(spectreName),
      grade,
      list_no: getCell(row, SPECTRE_MAP_COLS.HARAKA_CARD_NO) || null,
      image_url: getCell(row, SPECTRE_MAP_COLS.IMAGE_URL) || null,
      alt_image_url: null,
      rarity: null,
      rarity_icon_url: null,
      tag: getCell(row, SPECTRE_MAP_COLS.GROUP) || null,
      price_high: priceHigh,
      price_low: priceLow,
      image_status: 'unchecked',
      source: 'spectre',
    });
  }

  return result;
}
