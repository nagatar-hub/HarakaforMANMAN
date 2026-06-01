import { scaleManmanStoreLayout } from '../lib/manman-store-layout';
import type { LayoutConfig } from '@haraka/shared';

const baseLayout: LayoutConfig = {
  startX: 20,
  priceStartX: 10,
  colWidth: 180,
  cardWidth: 170,
  cardHeight: 210,
  isSmallCard: false,
  rows: [
    { cardY: 70, priceHighY: 250, priceLowY: 280 },
  ],
  priceBoxWidth: 150,
  priceBoxHeight: 40,
  dateX: 900,
  dateY: 1650,
};

describe('scaleManmanStoreLayout', () => {
  it('does not raise normal PSA price text too far', () => {
    const layout = scaleManmanStoreLayout(baseLayout);

    expect(layout.layoutAdjust).toEqual({ cardYDelta: -4, priceYDelta: -2 });
  });
});
