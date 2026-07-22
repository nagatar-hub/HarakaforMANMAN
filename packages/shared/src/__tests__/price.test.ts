import {
  calculateBoxPrice,
  calculateBoxPriceLow,
  calculateBuyPriceHigh,
} from '../utils/price';

describe('price source cap', () => {
  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s does not exceed an exact 100,000 source price', (_label, calculate) => {
    expect(calculate(100_000, 0)).toBe(100_000);
  });

  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s floors the source cap instead of returning a non-step price', (_label, calculate) => {
    expect(calculate(78_540, 0)).toBe(78_000);
  });

  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s preserves a rounded price that is already below its source', (_label, calculate) => {
    expect(calculate(12_800, 0.05)).toBe(12_500);
    expect(calculate(109_999, 0.01)).toBe(109_000);
  });

  it('caps BOX 30,000 at 30,000 when the rate is zero', () => {
    expect(calculateBoxPrice(30_000, 0)).toBe(30_000);
  });

  it.each([
    ['non-BOX', calculateBuyPriceHigh],
    ['BOX', calculateBoxPrice],
  ])('%s keeps the cap across low-price boundaries', (_label, calculate) => {
    expect(calculate(499, 0)).toBe(0);
    expect(calculate(500, 0)).toBe(500);
    expect(calculate(999, 0)).toBe(500);
    expect(calculate(1_000, 0)).toBe(1_000);
    expect(calculate(9_999, 0)).toBe(9_500);
    expect(calculate(10_000, 0)).toBe(10_000);
  });

  it('keeps Nami 78,540 at the MANMAN 5% rate equal to 75,000', () => {
    expect(calculateBuyPriceHigh(78_540, 0.05)).toBe(75_000);
  });

  it('caps misconfigured negative discounts at the source floor', () => {
    expect(calculateBuyPriceHigh(100_000, -0.10)).toBe(100_000);
    expect(calculateBoxPrice(100_000, -0.10)).toBe(100_000);
  });

  it('returns zero for zero-valued high, BOX, and BOX-low inputs', () => {
    expect(calculateBuyPriceHigh(0, 0)).toBe(0);
    expect(calculateBoxPrice(0, 0)).toBe(0);
    expect(calculateBoxPriceLow(0, 0)).toBe(0);
  });

  it('does not let BOX price_low exceed its price_high input', () => {
    expect(calculateBoxPriceLow(100_000, 0)).toBe(100_000);
    expect(calculateBoxPriceLow(78_540, 0)).toBe(78_000);
  });
});
