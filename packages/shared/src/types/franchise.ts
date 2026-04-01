export const FRANCHISES = ['Pokemon', 'ONE PIECE', 'YU-GI-OH!'] as const;
export type Franchise = typeof FRANCHISES[number];

export const FRANCHISE_JA: Record<Franchise, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};

export const KECAK_SHEET_MAP: Record<Franchise, string> = {
  'Pokemon': 'ポケモン',
  'ONE PIECE': 'ワンピース',
  'YU-GI-OH!': '遊戯王',
};
