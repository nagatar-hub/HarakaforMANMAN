import { normalizeText } from '@haraka/shared';
import { DB_COLS } from '@haraka/shared';

export type LookupResult = {
  /** タグ文字列（グループ） */
  tag: string;
  /** 画像URL */
  imageUrl: string | null;
  /** レアリティアイコン */
  rarityIcon: string | null;
};

/**
 * ルックアップマップの内部型
 * キー形式:
 *   exact     → "card_name|grade|list_no"
 *   nameGrade → "card_name|grade"
 *   nameOnly  → "card_name"
 */
export type LookupMap = {
  // キー形式: "card_name|grade|list_no"
  exact: Map<string, LookupResult>;
  // キー形式: "card_name|grade"
  nameGrade: Map<string, LookupResult>;
  // キー形式: "card_name"
  nameOnly: Map<string, LookupResult>;
};

/**
 * 文字列を正規化してルックアップキー用に変換する
 * NFC正規化 + 小文字化
 */
function normalizeKey(text: string): string {
  return normalizeText(text).toLowerCase();
}

/**
 * 値が空文字でなければそのまま、そうでなければ null を返す
 */
function toNullable(value: string | undefined): string | null {
  if (!value || value.trim() === '') return null;
  return value;
}

/**
 * DB_COLS は 1-indexed なので、配列インデックスは value - 1
 * 例: DB_COLS.CARD_NAME = 3 → row[2]
 */
function getCell(row: string[], colNumber: number): string {
  return row[colNumber - 1] ?? '';
}

/**
 * Haraka DB シートの行データからルックアップマップを構築
 * - 1行目（ヘッダ）をスキップ
 * - card_name が空の行をスキップ
 * - NFC 正規化適用
 * - 3段階のマップを構築
 */
export function buildLookupMap(dbRows: string[][]): LookupMap {
  const exact = new Map<string, LookupResult>();
  const nameGrade = new Map<string, LookupResult>();
  const nameOnly = new Map<string, LookupResult>();

  // 行数が 0 の場合は空のマップを返す
  if (dbRows.length === 0) {
    return { exact, nameGrade, nameOnly };
  }

  // 1行目（index 0）はヘッダなのでスキップ
  const dataRows = dbRows.slice(1);

  for (const row of dataRows) {
    const rawCardName = getCell(row, DB_COLS.CARD_NAME);
    // card_name が空の行はスキップ
    if (!rawCardName || rawCardName.trim() === '') continue;

    const cardName = normalizeKey(rawCardName);
    const grade = normalizeKey(getCell(row, DB_COLS.TYPE));
    const listNo = normalizeKey(getCell(row, DB_COLS.CARD_NO));
    const tag = getCell(row, DB_COLS.GROUP);
    const imageRaw = getCell(row, DB_COLS.ALT_IMAGE);
    const rarityIconRaw = getCell(row, DB_COLS.RARITY_ICON);

    const result: LookupResult = {
      tag,
      imageUrl: toNullable(imageRaw),
      rarityIcon: toNullable(rarityIconRaw),
    };

    // exact マップ: card_name + grade + list_no
    if (cardName && grade && listNo) {
      const exactKey = `${cardName}|${grade}|${listNo}`;
      exact.set(exactKey, result);
    }

    // nameGrade マップ: card_name + grade
    if (cardName && grade) {
      const nameGradeKey = `${cardName}|${grade}`;
      // 最初に登録されたものを優先（上書きしない）
      if (!nameGrade.has(nameGradeKey)) {
        nameGrade.set(nameGradeKey, result);
      }
    }

    // nameOnly マップ: card_name のみ
    if (cardName) {
      // 最初に登録されたものを優先（上書きしない）
      if (!nameOnly.has(cardName)) {
        nameOnly.set(cardName, result);
      }
    }
  }

  return { exact, nameGrade, nameOnly };
}

/**
 * 3段階照合: exact → nameGrade → nameOnly
 * 最初にマッチした結果を返す。マッチしなければ null
 */
export function lookupCard(
  map: LookupMap,
  card: { card_name: string; grade?: string | null; list_no?: string | null }
): LookupResult | null {
  const cardName = normalizeKey(card.card_name);
  const grade = card.grade ? normalizeKey(card.grade) : null;
  const listNo = card.list_no ? normalizeKey(card.list_no) : null;

  // ステージ1: exact（card_name + grade + list_no）
  if (cardName && grade && listNo) {
    const exactKey = `${cardName}|${grade}|${listNo}`;
    const exactResult = map.exact.get(exactKey);
    if (exactResult) return exactResult;
  }

  // ステージ2: nameGrade（card_name + grade）
  if (cardName && grade) {
    const nameGradeKey = `${cardName}|${grade}`;
    const nameGradeResult = map.nameGrade.get(nameGradeKey);
    if (nameGradeResult) return nameGradeResult;
  }

  // ステージ3: nameOnly（card_name のみ）
  if (cardName) {
    const nameOnlyResult = map.nameOnly.get(cardName);
    if (nameOnlyResult) return nameOnlyResult;
  }

  return null;
}
