export function normalizePreviewBasePrice(value: string | number): number {
  const normalized = typeof value === 'string'
    ? Number(value.replace(/[¥￥,\s]/g, ''))
    : value;

  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
}

function roundDiscountedPriceHigh(raw: number): number {
  if (!raw || raw <= 0) return 0;

  const base = Math.floor(raw / 1000) * 1000;
  const remainder = raw - base;
  return remainder <= 500 ? base + 500 : base + 1000;
}

export function calculateSteppedDiscountPreview(basePrice: string | number, ratePercent: number): number {
  const price = normalizePreviewBasePrice(basePrice);
  if (!price || !Number.isFinite(ratePercent)) return 0;

  return roundDiscountedPriceHigh(price * (1 - ratePercent / 100));
}
