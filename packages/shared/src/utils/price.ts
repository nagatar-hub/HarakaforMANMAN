import { FRANCHISES, type Franchise } from '../types/franchise.js';

export type Psa10DiscountRates = Partial<Record<Franchise, number>>;
export type BoxConditionDiscountRates = {
  shrink: number;
  no_shrink: number;
};
export type BoxDiscountRates = Record<Franchise, BoxConditionDiscountRates>;
export type StorePricingSettings = {
  box_discount_rates: BoxDiscountRates;
  psa10_discount_rates: Record<Franchise, number>;
};

export const DEFAULT_BUY_PRICE_HIGH_DISCOUNT_RATE = 0.15;
export const DEFAULT_BOX_SHRINK_DISCOUNT_RATE = 0.15;
export const DEFAULT_BOX_CONDITION_DISCOUNT_RATES: BoxConditionDiscountRates = {
  shrink: 0,
  no_shrink: DEFAULT_BOX_SHRINK_DISCOUNT_RATE,
};
export const DEFAULT_BOX_DISCOUNT_RATES: BoxDiscountRates = {
  Pokemon: { ...DEFAULT_BOX_CONDITION_DISCOUNT_RATES },
  'ONE PIECE': { ...DEFAULT_BOX_CONDITION_DISCOUNT_RATES },
  'YU-GI-OH!': { ...DEFAULT_BOX_CONDITION_DISCOUNT_RATES },
};
export const DEFAULT_PSA10_DISCOUNT_RATES: Record<Franchise, number> = {
  Pokemon: 0.12,
  'ONE PIECE': 0.12,
  'YU-GI-OH!': 0.15,
};
export const DEFAULT_STORE_PRICING_SETTINGS: StorePricingSettings = {
  box_discount_rates: DEFAULT_BOX_DISCOUNT_RATES,
  psa10_discount_rates: DEFAULT_PSA10_DISCOUNT_RATES,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBoxConditionDiscountRates(
  source: unknown,
  fallback: BoxConditionDiscountRates = DEFAULT_BOX_CONDITION_DISCOUNT_RATES,
): BoxConditionDiscountRates {
  const record = isRecord(source) ? source : {};
  return {
    shrink: numberOrDefault(record.shrink, fallback.shrink),
    no_shrink: numberOrDefault(record.no_shrink, fallback.no_shrink),
  };
}

export function normalizeStorePricingSettings(settings: unknown): StorePricingSettings {
  const source = isRecord(settings) ? settings : {};
  const boxRates = isRecord(source.box_discount_rates) ? source.box_discount_rates : {};
  const psa10Rates = isRecord(source.psa10_discount_rates) ? source.psa10_discount_rates : {};
  const normalizedPsa10Rates = { ...DEFAULT_PSA10_DISCOUNT_RATES };
  const legacyBoxRates = normalizeBoxConditionDiscountRates(boxRates);
  const normalizedBoxRates = {} as BoxDiscountRates;

  for (const franchise of FRANCHISES) {
    normalizedPsa10Rates[franchise] = numberOrDefault(
      psa10Rates[franchise],
      DEFAULT_PSA10_DISCOUNT_RATES[franchise],
    );
    normalizedBoxRates[franchise] = normalizeBoxConditionDiscountRates(
      boxRates[franchise],
      legacyBoxRates,
    );
  }

  return {
    box_discount_rates: normalizedBoxRates,
    psa10_discount_rates: normalizedPsa10Rates,
  };
}

export function mergeStorePricingSettings(base: unknown, overrides: unknown): StorePricingSettings {
  const normalizedBase = normalizeStorePricingSettings(base);
  const overrideRecord = isRecord(overrides) ? overrides : {};
  const boxOverrides = isRecord(overrideRecord.box_discount_rates) ? overrideRecord.box_discount_rates : {};
  const psa10Overrides = isRecord(overrideRecord.psa10_discount_rates) ? overrideRecord.psa10_discount_rates : {};
  const legacyBoxOverrides = isRecord(boxOverrides)
    ? normalizeBoxConditionDiscountRates(boxOverrides, DEFAULT_BOX_CONDITION_DISCOUNT_RATES)
    : DEFAULT_BOX_CONDITION_DISCOUNT_RATES;
  const mergedBoxRates = {} as BoxDiscountRates;

  for (const franchise of FRANCHISES) {
    const franchiseOverrides = isRecord(boxOverrides[franchise]) ? boxOverrides[franchise] : {};
    const hasLegacyBoxOverride =
      Object.prototype.hasOwnProperty.call(boxOverrides, 'shrink') ||
      Object.prototype.hasOwnProperty.call(boxOverrides, 'no_shrink');
    mergedBoxRates[franchise] = normalizeBoxConditionDiscountRates(
      {
        ...normalizedBase.box_discount_rates[franchise],
        ...(hasLegacyBoxOverride ? legacyBoxOverrides : {}),
        ...franchiseOverrides,
      },
      normalizedBase.box_discount_rates[franchise],
    );
  }

  return normalizeStorePricingSettings({
    ...normalizedBase,
    ...overrideRecord,
    box_discount_rates: mergedBoxRates,
    psa10_discount_rates: {
      ...normalizedBase.psa10_discount_rates,
      ...psa10Overrides,
    },
  });
}

/**
 * 端数処理 - GAS v3.15.0 niceLowerBound() の移植
 * 複数の刻み候補から raw に最も近い切り捨て値を選択
 */
export function niceLowerBound(raw: number): number {
  const steps =
    raw < 10_000 ? [500] :
    raw < 100_000 ? [1000, 2000, 5000] :
    raw < 300_000 ? [5000, 10000] :
    [10000, 20000, 50000];

  let bestV = 0;
  let bestDiff = Infinity;
  let bestStep = 0;

  for (const s of steps) {
    const v = Math.floor(raw / s) * s;
    const diff = raw - v;
    if (diff < bestDiff || (diff === bestDiff && s > bestStep)) {
      bestV = v;
      bestDiff = diff;
      bestStep = s;
    }
  }
  return bestV;
}

/**
 * 買取下限を計算 - GAS v3.15.0 calculateBuyPriceLow() の移植
 *
 * 割引率:
 * - 9,999円以下: 75%
 * - 10,000〜19,999円: 80%
 * - 20,000円以上: YU-GI-OH! は 85%, その他は 88%
 */
export function calculateBuyPriceLow(priceHigh: number, franchise: Franchise): number {
  if (!priceHigh || priceHigh <= 0) return 0;

  let rate: number;
  if (priceHigh <= 9_999) {
    rate = 0.75;
  } else if (priceHigh <= 19_999) {
    rate = 0.80;
  } else {
    rate = franchise === 'YU-GI-OH!' ? 0.85 : 0.88;
  }

  const raw = priceHigh * rate;
  return niceLowerBound(raw);
}

export function calculatePsa10PriceLow(priceHigh: number, discountRate: number): number {
  if (!priceHigh || priceHigh <= 0) return 0;
  return niceLowerBound(priceHigh * (1 - discountRate));
}

/**
 * 設定画面の割引率を適用した「後」の金額帯に応じて切り捨てる。
 *
 * - 9,999円以下: 100円単位（十の位以下を切り捨て）
 * - 10,000〜99,999円: 1,000円単位（百の位以下を切り捨て）
 * - 100,000〜999,999円: 10,000円単位（千の位以下を切り捨て）
 * - 1,000,000円以上: 100,000円単位（一万の位以下を切り捨て）
 */
export function floorDiscountedPriceByTier(discountedPrice: number): number {
  if (!Number.isFinite(discountedPrice) || discountedPrice <= 0) return 0;

  const step =
    discountedPrice < 10_000 ? 100 :
    discountedPrice < 100_000 ? 1_000 :
    discountedPrice < 1_000_000 ? 10_000 :
    100_000;

  return Math.floor(discountedPrice / step) * step;
}

function discountedPriceCappedAtSource(sourcePrice: number, discountRate: number): number {
  return Math.min(sourcePrice * (1 - discountRate), sourcePrice);
}

export function calculateBuyPriceHigh(basePrice: number, discountRate: number = DEFAULT_BUY_PRICE_HIGH_DISCOUNT_RATE): number {
  if (!basePrice || basePrice <= 0) return 0;
  return floorDiscountedPriceByTier(discountedPriceCappedAtSource(basePrice, discountRate));
}

/**
 * BOX 価格を計算
 * discountRate: 0.15 = 15% OFF（設定画面で変更可能）
 * PSA の price_high と同じく、割引後の金額帯に応じて切り捨てる
 */
export function calculateBoxPrice(price: number, discountRate: number = 0): number {
  if (!price || price <= 0) return 0;
  return floorDiscountedPriceByTier(discountedPriceCappedAtSource(price, discountRate));
}

export function calculateBoxPriceLow(priceHigh: number, discountRate: number = DEFAULT_BOX_SHRINK_DISCOUNT_RATE): number {
  return calculateBoxPrice(priceHigh, discountRate);
}
