export const COLS = {
  GROUP: 1,
  CARD_NAME: 2,
  TYPE: 3,
  CARD_NO: 4,
  IMAGE: 5,
  RARITY: 6,
  PRICE_HIGH: 7,
  PRICE_LOW: 8,
} as const;

/** DBタブのカラム配置（A=タイトル, B=タグ, C=ガチャ選択肢名称, ...） */
export const DB_COLS = {
  FRANCHISE: 1,    // A: タイトル（franchise名）
  GROUP: 2,        // B: タグ
  CARD_NAME: 3,    // C: ガチャ選択肢名称
  TYPE: 4,         // D: 種別
  CARD_NO: 5,      // E: list_no
  IMAGE: 6,        // F: 画像
  ALT_IMAGE: 7,    // G: 代替画像URL
  RARITY_ICON: 8,  // H: レアリティ
} as const;

export const SPECTRE_MAP_COLS = {
  GROUP: 1,
  SPECTRE_NAME: 2,
  SPECTRE_PRICE: 3,
  IMAGE_URL: 4,
  HARAKA_NAME: 5,
  HARAKA_TYPE: 6,
  HARAKA_CARD_NO: 7,
  BUY_PRICE: 8,
} as const;
