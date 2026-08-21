import { calculateBoxPrice, calculateBuyPriceHigh } from '@haraka/shared';
import {
  CONFIGURABLE_PRICING_FRANCHISES,
  calculateSteppedDiscountPreview,
  normalizePreviewBasePrice,
} from '@/lib/settings-preview';

describe('settings preview helpers', () => {
  it('keeps Peleka-aligned new products out of configurable pricing controls', () => {
    expect(CONFIGURABLE_PRICING_FRANCHISES).toEqual([
      'Pokemon',
      'ONE PIECE',
      'YU-GI-OH!',
    ]);
  });

  it('calculates merchant discount preview by flooring from the post-discount price tier', () => {
    expect(calculateSteppedDiscountPreview(30000, 6)).toBe(28000);
    expect(calculateSteppedDiscountPreview(12345, 12)).toBe(10000);
    expect(calculateSteppedDiscountPreview(12345, 15)).toBe(10000);
    expect(calculateSteppedDiscountPreview(1417800, 6)).toBe(1300000);
  });

  it('calculates BOX preview with the same post-discount tier flooring', () => {
    expect(calculateSteppedDiscountPreview(12800, 5)).toBe(12000);
    expect(calculateSteppedDiscountPreview(19000, 15)).toBe(16000);
  });

  it.each([
    [78_540, 5, 74_000],
    [12_800, 5, 12_000],
    [10_098, 5, 9_500],
    [105_000, 10, 94_000],
    [109_999, 1, 100_000],
    [30_000, 0, 30_000],
  ])(
    'keeps preview/runtime parity for source %i at %i%%',
    (sourcePrice, ratePercent, expected) => {
      const preview = calculateSteppedDiscountPreview(sourcePrice, ratePercent);
      expect(preview).toBe(expected);
      expect(preview).toBe(calculateBuyPriceHigh(sourcePrice, ratePercent / 100));
      expect(preview).toBe(calculateBoxPrice(sourcePrice, ratePercent / 100));
    },
  );

  it('normalizes invalid preview input to zero', () => {
    expect(normalizePreviewBasePrice('¥12,345')).toBe(12345);
    expect(normalizePreviewBasePrice(Number.NaN)).toBe(0);
    expect(normalizePreviewBasePrice(-500)).toBe(0);
  });
});
