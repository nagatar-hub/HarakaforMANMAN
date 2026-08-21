import {
  resolveManmanProfileGeometry,
  scaleManmanStoreLayout,
  type ManmanProfileGeometry,
} from '../lib/manman-store-layout';
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

describe('resolveManmanProfileGeometry', () => {
  const detected: ManmanProfileGeometry = {
    grid_cols: 6,
    grid_rows: 4,
    total_slots: 24,
    img_width: 1240,
    img_height: 1760,
    layout_config: {
      ...baseLayout,
      templateFileId_BOX: 'new-franchise-template',
      cardBackId_BOX: 'new-franchise-card-back',
    },
  };
  it.each(['WEISS SCHWARZ', 'DRAGON BALL'] as const)(
    'uses the proven Pokemon BOX geometry for %s',
    (franchise) => {
      const resolved = resolveManmanProfileGeometry(franchise, detected);
      expect(resolved.grid_cols).toBe(6);
      expect(resolved.grid_rows).toBe(5);
      expect(resolved.total_slots).toBe(30);
      expect(resolved.layout_config?.rowsBOX).toHaveLength(5);
      expect(resolved.layout_config?.rowsBOX?.every(row => row.priceHighY !== row.priceLowY)).toBe(true);
      expect(resolved.layout_config?.templateFileId_BOX).toBe('new-franchise-template');
      expect(resolved.layout_config?.cardBackId_BOX).toBe('new-franchise-card-back');
      expect(resolved.layout_config?.dateX).toBe(baseLayout.dateX);
      expect(resolved.layout_config?.dateY).toBe(baseLayout.dateY);
    },
  );

  it('keeps detected geometry for existing franchises', () => {
    expect(resolveManmanProfileGeometry('Pokemon', detected)).toBe(detected);
  });

  it('is stable across repeated uploads', () => {
    const once = resolveManmanProfileGeometry('WEISS SCHWARZ', detected);
    const twice = resolveManmanProfileGeometry('WEISS SCHWARZ', once);
    expect(twice).toEqual(once);
  });

  it('fails closed for an uncalibrated template size', () => {
    expect(() => resolveManmanProfileGeometry('WEISS SCHWARZ', { ...detected, img_width: 1080 }))
      .toThrow('1240x1760 MANMAN BOX profile geometry is required');
  });
});
