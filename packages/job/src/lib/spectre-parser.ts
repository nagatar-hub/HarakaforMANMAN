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

import type { Franchise, Database } from '@haraka/shared';
import { SPECTRE_MAP_COLS, normalizeText, calculateBuyPriceLow } from '@haraka/shared';

type PreparedCardInsert = Database['public']['Tables']['prepared_card']['Insert'];

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

/**
 * SpectreMapping シートを解析し、PreparedCard Insert 配列を返す
 *
 * - 1行目（ヘッダ）はスキップ
 * - SPECTRE_NAME が空の行はスキップ
 * - source = 'spectre'
 * - price_high = BUY_PRICE（H列）
 * - price_low = calculateBuyPriceLow(price_high, franchise)
 */
export function parseSpectreRows(
  rows: string[][],
  franchise: Franchise,
  runId: string,
): PreparedCardInsert[] {
  if (rows.length <= 1) return [];

  const dataRows = rows.slice(1); // ヘッダスキップ
  const result: PreparedCardInsert[] = [];

  for (const row of dataRows) {
    const spectreName = getCell(row, SPECTRE_MAP_COLS.SPECTRE_NAME);
    if (!spectreName || spectreName.trim() === '') continue;

    const priceHigh = safeNumber(getCell(row, SPECTRE_MAP_COLS.BUY_PRICE));
    const priceLow = priceHigh != null && priceHigh > 0 ? calculateBuyPriceLow(priceHigh, franchise) : null;

    result.push({
      run_id: runId,
      raw_import_id: null,
      franchise,
      card_name: normalizeText(spectreName),
      grade: getCell(row, SPECTRE_MAP_COLS.HARAKA_TYPE) || null,
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
