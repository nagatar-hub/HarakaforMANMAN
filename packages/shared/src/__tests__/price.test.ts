import {
  calculateBoxPrice,
  calculateBoxPriceLow,
  calculateBuyPriceHigh,
  calculatePelekaAlignedBuyPriceRange,
  floorDiscountedPriceByTier,
} from '../utils/price';

describe('post-discount tier flooring', () => {
  it.each([
    [0, 0],
    [99, 0],
    [100, 100],
    [101, 100],
    [9_999, 9_900],
    [9_999.99, 9_900],
    [10_000, 10_000],
    [10_001, 10_000],
    [99_999.99, 99_000],
    [100_000, 100_000],
    [100_001, 100_000],
    [999_999.99, 990_000],
    [1_000_000, 1_000_000],
    [1_000_001, 1_000_000],
  ])('floors discounted price %p to %i', (discountedPrice, expected) => {
    expect(floorDiscountedPriceByTier(discountedPrice)).toBe(expected);
  });

  it('returns zero for invalid discounted prices', () => {
    expect(floorDiscountedPriceByTier(Number.NaN)).toBe(0);
    expect(floorDiscountedPriceByTier(Number.POSITIVE_INFINITY)).toBe(0);
    expect(floorDiscountedPriceByTier(-1)).toBe(0);
  });

  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s chooses the tier from the discounted amount, not the source amount', (_label, calculate) => {
    expect(calculate(10_098, 0.05)).toBe(9_500);
    expect(calculate(100_000, 0.05)).toBe(95_000);
    expect(calculate(105_000, 0.10)).toBe(94_000);
    expect(calculate(1_000_000, 0.05)).toBe(950_000);
    expect(calculate(1_050_000, 0.05)).toBe(990_000);
  });

  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s applies the requested flooring at a zero discount', (_label, calculate) => {
    expect(calculate(99, 0)).toBe(0);
    expect(calculate(499, 0)).toBe(400);
    expect(calculate(999, 0)).toBe(900);
    expect(calculate(9_999, 0)).toBe(9_900);
    expect(calculate(10_000, 0)).toBe(10_000);
    expect(calculate(78_540, 0)).toBe(78_000);
    expect(calculate(100_000, 0)).toBe(100_000);
  });

  it('floors Nami 78,540 at the MANMAN 5% rate to 74,000', () => {
    expect(calculateBuyPriceHigh(78_540, 0.05)).toBe(74_000);
  });

  it('caps misconfigured negative discounts at the source before flooring', () => {
    expect(calculateBuyPriceHigh(100_000, -0.10)).toBe(100_000);
    expect(calculateBoxPrice(100_000, -0.10)).toBe(100_000);
  });

  it('returns zero for zero-valued and fully discounted prices', () => {
    expect(calculateBuyPriceHigh(0, 0)).toBe(0);
    expect(calculateBoxPrice(0, 0)).toBe(0);
    expect(calculateBoxPriceLow(0, 0)).toBe(0);
    expect(calculateBuyPriceHigh(10_000, 1)).toBe(0);
    expect(calculateBoxPrice(10_000, 1.5)).toBe(0);
  });

  it('uses the same post-discount tiers for BOX price_low', () => {
    expect(calculateBoxPriceLow(100_000, 0.05)).toBe(95_000);
    expect(calculateBoxPriceLow(10_000, 0.05)).toBe(9_500);
  });

  it.each([
    [100_000, 94_000, 87_000],
    [78_540, 73_500, 68_000],
    [508_980, 478_000, 442_500],
    [599_760, 563_500, 521_500],
    [275_000, 258_500, 239_000],
    [550_000, 517_000, 478_500],
    [1_100_000, 1_034_000, 957_000],
    [0, 0, 0],
  ])('Peleka trekaman Pokemon と同じ率・500円切捨てを %p 円へ適用する', (
    sourcePrice,
    expectedUpper,
    expectedLower,
  ) => {
    expect(calculatePelekaAlignedBuyPriceRange(sourcePrice)).toEqual({
      upper: expectedUpper,
      lower: expectedLower,
    });
  });
});
