import {
  DEFAULT_BOX_DISCOUNT_RATES,
  DEFAULT_BUY_PRICE_HIGH_DISCOUNT_RATE,
  DEFAULT_PSA10_DISCOUNT_RATES,
  mergeStorePricingSettings,
  normalizeStorePricingSettings,
} from '@haraka/shared';

describe('normalizeStorePricingSettings', () => {
  it('設定画面の価格キーを canonical な3種類として正規化する', () => {
    const settings = normalizeStorePricingSettings({
      buy_price_high_discount_rate: 0.18,
      box_discount_rates: {
        shrink: 0.03,
        no_shrink: 0.22,
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
      },
      box_shrink_discount_rate: 0.45,
    });

    expect(settings).toEqual({
      buy_price_high_discount_rate: 0.18,
      box_discount_rates: {
        shrink: 0.03,
        no_shrink: 0.22,
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
      },
    });
  });

  it('旧 box_shrink_discount_rate を runtime のフォールバックに使わない', () => {
    const settings = normalizeStorePricingSettings({
      box_shrink_discount_rate: 0.45,
    });

    expect(settings.buy_price_high_discount_rate).toBe(DEFAULT_BUY_PRICE_HIGH_DISCOUNT_RATE);
    expect(settings.box_discount_rates).toEqual(DEFAULT_BOX_DISCOUNT_RATES);
    expect(settings.psa10_discount_rates).toEqual(DEFAULT_PSA10_DISCOUNT_RATES);
  });

  it('部分更新でも既存の価格設定を保持する', () => {
    const settings = mergeStorePricingSettings(
      {
        buy_price_high_discount_rate: 0.18,
        box_discount_rates: {
          shrink: 0.03,
          no_shrink: 0.22,
        },
        psa10_discount_rates: {
          Pokemon: 0.11,
          'ONE PIECE': 0.12,
          'YU-GI-OH!': 0.13,
        },
      },
      {
        box_discount_rates: {
          no_shrink: 0.24,
        },
      },
    );

    expect(settings).toEqual({
      buy_price_high_discount_rate: 0.18,
      box_discount_rates: {
        shrink: 0.03,
        no_shrink: 0.24,
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
      },
    });
  });
});
