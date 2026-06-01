import type { LayoutConfig } from '@haraka/shared';

const MANMAN_STORE_CARD_Y_DELTA = -4;
const MANMAN_STORE_PRICE_Y_DELTA = -2;

export function scaleManmanStoreLayout(layout: LayoutConfig): LayoutConfig {
  const iconSize = Math.max(20, Math.round(layout.cardWidth * 0.45));
  return {
    ...layout,
    rarityIconWidth: iconSize,
    rarityIconHeight: iconSize,
    rarityIconOffsetY: Math.round(layout.cardHeight * (-10 / 170)),
    layoutAdjust: {
      cardYDelta: MANMAN_STORE_CARD_Y_DELTA,
      priceYDelta: MANMAN_STORE_PRICE_Y_DELTA,
    },
  };
}
