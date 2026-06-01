import { makeBoxLayout } from '../lib/box-layout';
import type { LayoutConfig } from '@haraka/shared';

function makeProfileLayout(overrides: Partial<LayoutConfig> = {}): LayoutConfig {
  return {
    startX: 20,
    priceStartX: 10,
    colWidth: 180,
    cardWidth: 170,
    cardHeight: 210,
    isSmallCard: false,
    rows: [
      { cardY: 70, priceHighY: 250, priceLowY: 280 },
      { cardY: 310, priceHighY: 500, priceLowY: 530 },
    ],
    priceBoxWidth: 150,
    priceBoxHeight: 30,
    dateX: 900,
    dateY: 1650,
    rarityIconWidth: 60,
    rarityIconHeight: 60,
    ...overrides,
  };
}

describe('makeBoxLayout', () => {
  it('BOX画像を価格枠の直上に寄せる', () => {
    const layout = makeBoxLayout(makeProfileLayout());

    expect(layout.cardWidth).toBe(150);
    expect(layout.cardHeight).toBe(185);
    expect(layout.rows[0].cardY).toBe(250 - 185 - 6);
    expect(layout.rows[1].cardY).toBe(500 - 185 - 6);
    expect(layout.layoutAdjust).toEqual({ cardYDelta: 0, priceYDelta: -6 });
    expect(layout.cardFit).toBe('contain');
    expect(layout.rarityIconWidth).toBeUndefined();
  });

  it('rowsBOX があれば BOX 専用行座標を基準にする', () => {
    const layout = makeBoxLayout(makeProfileLayout({
      rowsBOX: [
        { cardY: 1, priceHighY: 300, priceLowY: 330 },
      ],
    }));

    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0]).toEqual({
      cardY: 300 - 185 - 6,
      priceHighY: 300,
      priceLowY: 330,
    });
  });
});
