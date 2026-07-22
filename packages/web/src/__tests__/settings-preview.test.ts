import { calculateBoxPrice, calculateBuyPriceHigh } from '@haraka/shared';
import {
  calculateSteppedDiscountPreview,
  normalizePreviewBasePrice,
} from '@/lib/settings-preview';

describe('settings preview helpers', () => {
  it('calculates merchant discount preview by rounding discounted price up to the next 500 or 1000 yen boundary', () => {
    expect(calculateSteppedDiscountPreview(30000, 6)).toBe(28500);
    expect(calculateSteppedDiscountPreview(12345, 12)).toBe(11000);
    expect(calculateSteppedDiscountPreview(12345, 15)).toBe(10500);
    expect(calculateSteppedDiscountPreview(1417800, 6)).toBe(1333000);
  });

  it('calculates BOX preview with the same 500/1000 yen stepped rounding', () => {
    expect(calculateSteppedDiscountPreview(12800, 5)).toBe(12500);
    expect(calculateSteppedDiscountPreview(19000, 15)).toBe(16500);
  });

  it.each([
    [78_540, 5, 75_000],
    [12_800, 5, 12_500],
    [109_999, 1, 109_000],
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
