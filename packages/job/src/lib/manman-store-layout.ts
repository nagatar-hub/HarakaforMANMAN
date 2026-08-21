import type { AssetProfileRow, Franchise, LayoutConfig } from '@haraka/shared';

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

export type ManmanProfileGeometry = Pick<
  AssetProfileRow,
  'grid_cols' | 'grid_rows' | 'total_slots' | 'img_width' | 'img_height' | 'layout_config'
>;

const MANMAN_BOX_ROWS = [
  { cardY: 268, priceHighY: 488, priceLowY: 520 },
  { cardY: 533, priceHighY: 753, priceLowY: 785 },
  { cardY: 803, priceHighY: 1023, priceLowY: 1056 },
  { cardY: 1068, priceHighY: 1288, priceLowY: 1320 },
  { cardY: 1332, priceHighY: 1552, priceLowY: 1584 },
];

export function resolveManmanProfileGeometry(
  franchise: Franchise,
  detected: ManmanProfileGeometry,
): ManmanProfileGeometry {
  if (franchise !== 'WEISS SCHWARZ' && franchise !== 'DRAGON BALL') return detected;
  const detectedLayout = detected.layout_config;
  if (!detectedLayout || detected.img_width !== 1240 || detected.img_height !== 1760) {
    throw new Error(`1240x1760 MANMAN BOX profile geometry is required for ${franchise}`);
  }
  return {
    grid_cols: 6,
    grid_rows: 5,
    total_slots: 30,
    img_width: 1240,
    img_height: 1760,
    layout_config: {
      ...detectedLayout,
      startX: 71,
      priceStartX: 78,
      colWidth: 189,
      cardWidth: 150,
      cardHeight: 210,
      rowsBOX: MANMAN_BOX_ROWS,
      priceBoxWidth: 136,
      priceBoxHeight: 40,
    },
  };
}
