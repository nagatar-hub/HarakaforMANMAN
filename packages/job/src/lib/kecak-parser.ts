import type { Franchise } from '@haraka/shared';
import type { Database } from '@haraka/shared';
import { normalizeText } from '@haraka/shared';

type RawImportInsert = Database['public']['Tables']['raw_import']['Insert'];

/**
 * フランチャイズごとのカラムインデックス定義
 *
 * YU-GI-OH! (KECAK シート):
 *   - col 0 (A列): card_name
 *   - col 1 (B列): grade
 *   - col 3 (D列): list_no
 *   - col 4 (E列): rarity
 *   - col 5 (F列): image_url
 *   - col 7 (H列): kecak_price
 *
 * Pokemon / ONE PIECE (KECAK シート):
 *   - col 0 (A列): card_name
 *   - col 1 (B列): grade
 *   - col 2 (C列): list_no
 *   - col 3 (D列): image_url
 *   - col 5 (F列): kecak_price
 *   - rarity: なし (null)
 */
type ColumnMapping = {
  cardName: number;
  grade: number;
  listNo: number;
  rarity: number | null;
  imageUrl: number;
  demand: number;
  kecakPrice: number;
};

const YUGIOH_COLS: ColumnMapping = {
  cardName: 0,
  grade: 1,
  listNo: 3,
  rarity: 4,
  imageUrl: 5,
  demand: 6,
  kecakPrice: 7,
};

const POKEMON_ONEPIECE_COLS: ColumnMapping = {
  cardName: 0,
  grade: 1,
  listNo: 2,
  rarity: null,
  imageUrl: 3,
  demand: 4,
  kecakPrice: 5,
};

/**
 * フランチャイズに対応するカラムマッピングを返す
 */
function getColumnMapping(franchise: Franchise): ColumnMapping {
  if (franchise === 'YU-GI-OH!') {
    return YUGIOH_COLS;
  }
  return POKEMON_ONEPIECE_COLS;
}

/**
 * 文字列を安全に取得する（空文字は null に変換しない）
 */
function safeString(value: string | undefined): string {
  return normalizeText(value ?? '');
}

/**
 * 文字列を数値に変換する。空文字または変換不能な場合は null を返す
 * 通貨記号（¥, $, ￥）やカンマを除去して数値化する
 */
function safeNumber(value: string | undefined): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replace(/[¥￥$,、\s]/g, '');
  if (cleaned === '') return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * 行データをインデックスをキーとした JSONB オブジェクトに変換する
 */
function rowToJsonb(row: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  row.forEach((cell, idx) => {
    result[String(idx)] = cell;
  });
  return result;
}

/**
 * KECAK シートの行データを RawImport の Insert 配列に変換
 * - 1行目（ヘッダ）をスキップ
 * - card_name が空の行をスキップ
 * - NFC 正規化を適用
 * - raw_row に元データを JSONB として保存
 */
export function parseKecakRows(
  rows: string[][],
  franchise: Franchise,
  runId: string
): RawImportInsert[] {
  // 行数が 0 の場合は空配列を返す
  if (rows.length === 0) return [];

  const cols = getColumnMapping(franchise);

  // 1行目（index 0）はヘッダなのでスキップ
  const dataRows = rows.slice(1);

  return dataRows.reduce<RawImportInsert[]>((acc, row) => {
    const cardName = safeString(row[cols.cardName]);

    // card_name が空の行はスキップ
    if (!cardName) return acc;

    const grade = safeString(row[cols.grade]) || null;
    const listNo = safeString(row[cols.listNo]) || null;
    const imageUrl = safeString(row[cols.imageUrl]) || null;
    const rarity = cols.rarity !== null
      ? (safeString(row[cols.rarity]) || null)
      : null;
    const demand = safeNumber(row[cols.demand]);
    const kecakPrice = safeNumber(row[cols.kecakPrice]);

    const record: RawImportInsert = {
      run_id: runId,
      franchise,
      card_name: cardName,
      grade,
      list_no: listNo,
      image_url: imageUrl,
      rarity,
      demand,
      kecak_price: kecakPrice,
      raw_row: rowToJsonb(row),
    };

    acc.push(record);
    return acc;
  }, []);
}
