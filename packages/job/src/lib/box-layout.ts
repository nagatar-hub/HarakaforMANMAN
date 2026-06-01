import type { LayoutConfig } from '@haraka/shared';

const BOX_CARD_WIDTH_RATIO = 0.9;
const BOX_CARD_HEIGHT_RATIO = 0.88;
const BOX_CARD_PRICE_GAP = 6;
const BOX_CARD_Y_LIFT = 8;
const BOX_PRICE_Y_DELTA = -10;

export function makeBoxLayout(profileLayout: LayoutConfig): LayoutConfig {
  const baseWidth = profileLayout.cardWidth;
  const boxCardWidth = Math.min(profileLayout.priceBoxWidth, Math.round(baseWidth * BOX_CARD_WIDTH_RATIO));
  const boxCardHeight = Math.round(profileLayout.cardHeight * BOX_CARD_HEIGHT_RATIO);
  const sourceRows = profileLayout.rowsBOX ?? profileLayout.rows;
  const rows = sourceRows.map(row => ({
    ...row,
    cardY: row.priceHighY - boxCardHeight - BOX_CARD_PRICE_GAP - BOX_CARD_Y_LIFT,
  }));

  return {
    ...profileLayout,
    rows,
    startX: profileLayout.startX + Math.round((baseWidth - boxCardWidth) / 2),
    cardWidth: boxCardWidth,
    cardHeight: boxCardHeight,
    cardFit: 'contain',
    layoutAdjust: { cardYDelta: 0, priceYDelta: BOX_PRICE_Y_DELTA },
    rarityIconWidth: undefined,
    rarityIconHeight: undefined,
  };
}
