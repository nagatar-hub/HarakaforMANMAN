import {
  calculateBoxPrice,
  calculateBoxPriceHigh,
  calculateBoxPriceLow,
  calculateBuyPriceHigh,
  calculatePelekaAlignedBuyPriceRange,
  floorDiscountedPriceByTier,
  mergeStorePricingSettings,
  normalizeStorePricingSettings,
  validateTokyoOutlierGuard,
  validateTokyoSourceDiscountRates,
} from '../utils/price';

describe('Tokyo source discount settings', () => {
  it('uses the approved five-source defaults and preserves a partial source update', () => {
    const defaults = normalizeStorePricingSettings({});
    expect(defaults.tokyo_source_discount_rates).toEqual({
      kecak: { high: 0.05, low: 0.05 }, blue_rocket: { high: 0.10, low: 0.10 },
      toreca_bank: { high: 0.10, low: 0.10 }, avirile: { high: 0.10, low: 0.10 },
      shinsoku: { high: 0.05, low: 0.05 },
    });
    const merged = mergeStorePricingSettings(defaults, { tokyo_source_discount_rates: { kecak: { high: 0.04 } } });
    expect(merged.tokyo_source_discount_rates.kecak).toEqual({ high: 0.04, low: 0.05 });
    expect(merged.tokyo_source_discount_rates.blue_rocket).toEqual({ high: 0.10, low: 0.10 });
  });

  it('rejects out-of-range and inverted high/low settings', () => {
    const settings = normalizeStorePricingSettings({});
    expect(validateTokyoSourceDiscountRates(settings.tokyo_source_discount_rates)).toBeNull();
    expect(validateTokyoSourceDiscountRates({ ...settings.tokyo_source_discount_rates,
      kecak: { high: -0.01, low: 0.05 } })).toContain('0〜100%');
    expect(validateTokyoSourceDiscountRates({ ...settings.tokyo_source_discount_rates,
      shinsoku: { high: 0.10, low: 0.05 } })).toContain('下限減額率');
  });
});

describe('Tokyo outlier guard settings', () => {
  it('defaults to 10x the other sources and a 10,000,000 yen source ceiling', () => {
    const defaults = normalizeStorePricingSettings({});
    expect(defaults.tokyo_outlier_guard).toEqual({ max_median_ratio: 10, max_source_price: 10_000_000 });
    expect(validateTokyoOutlierGuard(defaults.tokyo_outlier_guard)).toBeNull();
    const merged = mergeStorePricingSettings(defaults, { tokyo_outlier_guard: { max_median_ratio: 5 } });
    expect(merged.tokyo_outlier_guard).toEqual({ max_median_ratio: 5, max_source_price: 10_000_000 });
  });

  it('rejects a ratio that would exclude every source and a non-integer or out-of-range ceiling', () => {
    for (const ratio of [1, 1.9, 0, -1, NaN, Infinity, 1001]) {
      expect(validateTokyoOutlierGuard({ max_median_ratio: ratio, max_source_price: 10_000_000 })).toContain('倍率');
    }
    for (const price of [999, 0, -1, 1000.5, NaN, Infinity, 100_000_001]) {
      expect(validateTokyoOutlierGuard({ max_median_ratio: 10, max_source_price: price })).toContain('元価格上限');
    }
  });
});

describe('BOX upper price from raw S', () => {
  it.each([[999, 0], [10000, 9000], [20000, 18000], [100000, 93000], [1000000, 930000], [20431, 19000]])(
    '%i の元価格に7%引きを一度適用し、全価格帯で1000円未満切捨て', (raw, expected) => {
      expect(calculateBoxPriceHigh(raw, 0.07)).toBe(expected);
    },
  );
});

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
