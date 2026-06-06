import {
  calculateHundredYenDiscountPreview,
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

  it('keeps BOX preview on 100 yen floor rounding', () => {
    expect(calculateHundredYenDiscountPreview(10000, 6)).toBe(9400);
  });

  it('normalizes invalid preview input to zero', () => {
    expect(normalizePreviewBasePrice('¥12,345')).toBe(12345);
    expect(normalizePreviewBasePrice(Number.NaN)).toBe(0);
    expect(normalizePreviewBasePrice(-500)).toBe(0);
  });
});
