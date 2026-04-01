/**
 * db_card テーブル用の行変換ヘルパー
 *
 * DBシートの生データ（string[][]）を db_card テーブルの insert/upsert 形式に変換する。
 */

import { DB_COLS } from '@haraka/shared';

export type DbCardInsert = {
  franchise: string;
  tag: string | null;
  card_name: string;
  grade: string;       // upsert用ユニーク制約のため空文字で格納（NULLは不可）
  list_no: string;     // 同上
  image_url: string | null;
  alt_image_url: string | null;
  rarity_icon: string | null;
  sheet_row_number: number;
};

/**
 * 値が空文字の場合は null に変換
 */
function toNullable(value: string | undefined): string | null {
  if (!value || value.trim() === '') return null;
  return value;
}

/**
 * DB_COLS は 1-indexed なので配列インデックスは value - 1
 */
function getCell(row: string[], colNumber: number): string {
  return row[colNumber - 1] ?? '';
}

/**
 * DBシートのデータ行（ヘッダ除く）を db_card テーブル用のオブジェクト配列に変換する。
 *
 * @param dbDataRows - DBシートのデータ行（ヘッダ行を含まない）
 * @returns db_card テーブル用の insert データ配列
 */
export function buildDbCardRows(dbDataRows: string[][]): DbCardInsert[] {
  // 重複排除用マップ（同一キーは後勝ち＝シート下の行が最新）
  const dedup = new Map<string, DbCardInsert>();

  for (let i = 0; i < dbDataRows.length; i++) {
    const row = dbDataRows[i];
    const cardName = getCell(row, DB_COLS.CARD_NAME).trim();

    // card_name が空の行はスキップ
    if (!cardName) continue;

    const franchise = getCell(row, DB_COLS.FRANCHISE).trim();
    const grade = getCell(row, DB_COLS.TYPE).trim();
    const listNo = getCell(row, DB_COLS.CARD_NO).trim();

    const key = `${franchise}|${cardName}|${grade}|${listNo}`;

    dedup.set(key, {
      franchise,
      tag: toNullable(getCell(row, DB_COLS.GROUP)),
      card_name: cardName,
      grade,       // 空文字のまま（upsert用）
      list_no: listNo, // 空文字のまま（upsert用）
      image_url: toNullable(getCell(row, DB_COLS.IMAGE)),
      alt_image_url: toNullable(getCell(row, DB_COLS.ALT_IMAGE)),
      rarity_icon: toNullable(getCell(row, DB_COLS.RARITY_ICON)),
      // シートの行番号 = dataRowIndex + 2（ヘッダ行=1、0-indexed→1-indexed=+1、+ヘッダ=+1）
      sheet_row_number: i + 2,
    });
  }

  return [...dedup.values()];
}
