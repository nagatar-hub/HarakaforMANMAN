import { calculateBuyPriceHigh, type Franchise } from '@haraka/shared';

export const CONFIGURABLE_PRICING_FRANCHISES = [
  'Pokemon',
  'ONE PIECE',
  'YU-GI-OH!',
] as const satisfies readonly Franchise[];

export function normalizePreviewBasePrice(value: string | number): number {
  const normalized = typeof value === 'string'
    ? Number(value.replace(/[¥￥,\s]/g, ''))
    : value;

  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
}

export function calculateSteppedDiscountPreview(basePrice: string | number, ratePercent: number): number {
  const price = normalizePreviewBasePrice(basePrice);
  if (!price || !Number.isFinite(ratePercent)) return 0;

  return calculateBuyPriceHigh(price, ratePercent / 100);
}
