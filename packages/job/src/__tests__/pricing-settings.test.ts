import {
  DEFAULT_BOX_DISCOUNT_RATES,
  DEFAULT_PSA10_DISCOUNT_RATES,
  DEFAULT_TOKYO_OUTLIER_GUARD,
  DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS,
  DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES,
  mergeStorePricingSettings,
  normalizeStorePricingSettings,
} from '@haraka/shared';

describe('normalizeStorePricingSettings', () => {
  it('BOX下限表示はbooleanだけを保持し、部分更新でも既存値を維持する', () => {
    expect(normalizeStorePricingSettings({}).box_price_low_enabled).toBeUndefined();
    expect(normalizeStorePricingSettings({ box_price_low_enabled: true }).box_price_low_enabled).toBe(true);
    expect(normalizeStorePricingSettings({ box_price_low_enabled: false }).box_price_low_enabled).toBe(false);
    expect(normalizeStorePricingSettings({ box_price_low_enabled: 'true' }).box_price_low_enabled).toBeUndefined();
    expect(mergeStorePricingSettings(
      { box_price_low_enabled: true },
      { psa10_discount_rates: { Pokemon: 0.11 } },
    ).box_price_low_enabled).toBe(true);
    expect(mergeStorePricingSettings(
      { box_price_low_enabled: true },
      { box_price_low_enabled: false },
    ).box_price_low_enabled).toBe(false);
  });

  it('設定画面の価格キーを canonical な2種類として正規化する', () => {
    const settings = normalizeStorePricingSettings({
      buy_price_high_discount_rate: 0.18,
      box_discount_rates: {
        Pokemon: {
          shrink: 0.03,
          no_shrink: 0.22,
        },
        'ONE PIECE': {
          shrink: 0.04,
          no_shrink: 0.23,
        },
        'YU-GI-OH!': {
          shrink: 0.05,
          no_shrink: 0.24,
        },
        'WEISS SCHWARZ': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
        'DRAGON BALL': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
        'WEISS SCHWARZ': 0.06,
        'DRAGON BALL': 0.06,
      },
      box_shrink_discount_rate: 0.45,
    });

    expect(settings).toEqual({
      box_discount_rates: {
        Pokemon: {
          shrink: 0.03,
          no_shrink: 0.22,
        },
        'ONE PIECE': {
          shrink: 0.04,
          no_shrink: 0.23,
        },
        'YU-GI-OH!': {
          shrink: 0.05,
          no_shrink: 0.24,
        },
        'WEISS SCHWARZ': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
        'DRAGON BALL': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
        'WEISS SCHWARZ': 0.06,
        'DRAGON BALL': 0.06,
      },
      tokyo_source_discount_rates: DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES,
      tokyo_outlier_guard: DEFAULT_TOKYO_OUTLIER_GUARD,
      tokyo_price_max_age_days: DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS,
    });
  });

  it('旧 box_shrink_discount_rate を runtime のフォールバックに使わない', () => {
    const settings = normalizeStorePricingSettings({
      box_shrink_discount_rate: 0.45,
    });

    expect(settings.box_discount_rates).toEqual(DEFAULT_BOX_DISCOUNT_RATES);
    expect(settings.psa10_discount_rates).toEqual(DEFAULT_PSA10_DISCOUNT_RATES);
  });

  it('旧 buy_price_high_discount_rate を canonical settings から落とす', () => {
    const settings = normalizeStorePricingSettings({
      buy_price_high_discount_rate: 0.45,
    });

    expect(settings).not.toHaveProperty('buy_price_high_discount_rate');
  });

  it('部分更新でも既存の価格設定を保持する', () => {
    const settings = mergeStorePricingSettings(
      {
        box_discount_rates: {
          Pokemon: {
            shrink: 0.03,
            no_shrink: 0.22,
          },
          'ONE PIECE': {
            shrink: 0.04,
            no_shrink: 0.23,
          },
          'YU-GI-OH!': {
            shrink: 0.05,
            no_shrink: 0.24,
          },
        },
        psa10_discount_rates: {
          Pokemon: 0.11,
          'ONE PIECE': 0.12,
          'YU-GI-OH!': 0.13,
        },
      },
      {
        box_discount_rates: {
          Pokemon: {
            no_shrink: 0.24,
          },
        },
      },
    );

    expect(settings).toEqual({
      box_discount_rates: {
        Pokemon: {
          shrink: 0.03,
          no_shrink: 0.24,
        },
        'ONE PIECE': {
          shrink: 0.04,
          no_shrink: 0.23,
        },
        'YU-GI-OH!': {
          shrink: 0.05,
          no_shrink: 0.24,
        },
        'WEISS SCHWARZ': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
        'DRAGON BALL': {
          shrink: 0.06,
          no_shrink: 0.13,
        },
      },
      psa10_discount_rates: {
        Pokemon: 0.11,
        'ONE PIECE': 0.12,
        'YU-GI-OH!': 0.13,
        'WEISS SCHWARZ': 0.06,
        'DRAGON BALL': 0.06,
      },
      tokyo_source_discount_rates: DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES,
      tokyo_outlier_guard: DEFAULT_TOKYO_OUTLIER_GUARD,
      tokyo_price_max_age_days: DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS,
    });
  });

  it('旧グローバルBOX割引率は全商材のBOX割引率として読み替える', () => {
    const settings = normalizeStorePricingSettings({
      box_discount_rates: {
        shrink: 0.05,
        no_shrink: 0.18,
      },
    });

    expect(settings.box_discount_rates).toEqual({
      Pokemon: {
        shrink: 0.05,
        no_shrink: 0.18,
      },
      'ONE PIECE': {
        shrink: 0.05,
        no_shrink: 0.18,
      },
      'YU-GI-OH!': {
        shrink: 0.05,
        no_shrink: 0.18,
      },
      'WEISS SCHWARZ': {
        shrink: 0.05,
        no_shrink: 0.18,
      },
      'DRAGON BALL': {
        shrink: 0.05,
        no_shrink: 0.18,
      },
    });
  });
});
