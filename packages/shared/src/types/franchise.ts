export const FRANCHISES = [
  'Pokemon',
  'ONE PIECE',
  'YU-GI-OH!',
  'WEISS SCHWARZ',
  'DRAGON BALL',
] as const;
export type Franchise = typeof FRANCHISES[number];

export const FRANCHISE_JA: Record<Franchise, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
  'WEISS SCHWARZ': 'ヴァイスシュヴァルツ',
  'DRAGON BALL': 'ドラゴンボールカード',
};

export const KECAK_SHEET_MAP: Record<Franchise, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
  'WEISS SCHWARZ': 'ヴァイス',
  'DRAGON BALL': 'ドラゴンボール',
};

export const FRANCHISE_STORAGE_SLUG: Record<Franchise, string> = {
  'Pokemon': 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
  'WEISS SCHWARZ': 'weiss_schwarz',
  'DRAGON BALL': 'dragon_ball',
};
