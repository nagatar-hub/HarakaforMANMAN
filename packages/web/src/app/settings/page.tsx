'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  CONFIGURABLE_PRICING_FRANCHISES,
  calculateSteppedDiscountPreview,
  normalizePreviewBasePrice,
} from '@/lib/settings-preview';
import {
  DEFAULT_TOKYO_OUTLIER_GUARD,
  DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS,
  DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES,
  FRANCHISES,
  FRANCHISE_JA,
  TOKYO_PRICE_SOURCES,
  calculateBoxPriceHigh,
  calculatePelekaAlignedBuyPriceRange,
  type Franchise,
  type TokyoOutlierGuard,
  type TokyoPriceSource,
} from '@haraka/shared';

type Psa10Rates = Record<Franchise, number>;
type BoxConditionRates = {
  shrink: number;
  no_shrink: number;
};
type BoxRates = Record<Franchise, BoxConditionRates>;
type TokyoSourceRates = Record<TokyoPriceSource, { high: number; low: number }>;

interface StoreConfig {
  store: string;
  settings: {
    box_price_low_enabled?: boolean;
    box_discount_rates?: Partial<Record<Franchise, Partial<BoxConditionRates>>>;
    psa10_discount_rates?: Partial<Record<Franchise, number>>;
    tokyo_source_discount_rates?: Partial<Record<TokyoPriceSource, Partial<{ high: number; low: number }>>>;
    tokyo_outlier_guard?: Partial<TokyoOutlierGuard>;
    tokyo_price_max_age_days?: number;
  };
}

const FRANCHISE_OPTIONS = CONFIGURABLE_PRICING_FRANCHISES.map((key) => ({ key, label: FRANCHISE_JA[key] }));
const BOX_FRANCHISE_OPTIONS = FRANCHISES.map((key) => ({ key, label: FRANCHISE_JA[key] }));

const DEFAULT_PSA10_RATES: Psa10Rates = {
  Pokemon: 12,
  'ONE PIECE': 12,
  'YU-GI-OH!': 15,
  'WEISS SCHWARZ': 6,
  'DRAGON BALL': 6,
};

const DEFAULT_BOX_CONDITION_RATES: BoxConditionRates = {
  shrink: 0,
  no_shrink: 15,
};
const DEFAULT_BOX_RATES: BoxRates = {
  Pokemon: { ...DEFAULT_BOX_CONDITION_RATES },
  'ONE PIECE': { ...DEFAULT_BOX_CONDITION_RATES },
  'YU-GI-OH!': { ...DEFAULT_BOX_CONDITION_RATES },
  'WEISS SCHWARZ': { shrink: 6, no_shrink: 13 },
  'DRAGON BALL': { shrink: 6, no_shrink: 13 },
};
const TOKYO_SOURCE_LABELS: Record<TokyoPriceSource, string> = {
  kecak: 'KECAK',
  blue_rocket: 'Blue Rocket',
  toreca_bank: 'トレカバンク',
  avirile: 'アヴィリール',
  shinsoku: 'シンソク郵送買取',
};
const DEFAULT_TOKYO_SOURCE_RATES = Object.fromEntries(TOKYO_PRICE_SOURCES.map(source => [source, {
  high: DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES[source].high * 100,
  low: DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES[source].low * 100,
}])) as TokyoSourceRates;

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(50, Math.max(0, value));
}

function toPercent(value: number | undefined, fallback: number): number {
  return Math.round((value ?? fallback / 100) * 100);
}

function normalizeBoxRates(savedBoxRates: StoreConfig['settings']['box_discount_rates']): BoxRates {
  return BOX_FRANCHISE_OPTIONS.reduce((acc, { key }) => {
    const savedRates = savedBoxRates?.[key] ?? {};
    acc[key] = {
      shrink: toPercent(savedRates.shrink, DEFAULT_BOX_RATES[key].shrink),
      no_shrink: toPercent(savedRates.no_shrink, DEFAULT_BOX_RATES[key].no_shrink),
    };
    return acc;
  }, {} as BoxRates);
}

function normalizeTokyoSourceRates(saved: StoreConfig['settings']['tokyo_source_discount_rates']): TokyoSourceRates {
  return Object.fromEntries(TOKYO_PRICE_SOURCES.map(source => [source, {
    high: (saved?.[source]?.high ?? DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES[source].high) * 100,
    low: (saved?.[source]?.low ?? DEFAULT_TOKYO_SOURCE_DISCOUNT_RATES[source].low) * 100,
  }])) as TokyoSourceRates;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [boxPriceLowEnabled, setBoxPriceLowEnabled] = useState(false);
  const [boxRates, setBoxRates] = useState<BoxRates>(DEFAULT_BOX_RATES);
  const [psa10Rates, setPsa10Rates] = useState<Psa10Rates>(DEFAULT_PSA10_RATES);
  const [tokyoSourceRates, setTokyoSourceRates] = useState<TokyoSourceRates>(DEFAULT_TOKYO_SOURCE_RATES);
  const [outlierGuard, setOutlierGuard] = useState<TokyoOutlierGuard>(DEFAULT_TOKYO_OUTLIER_GUARD);
  const [priceMaxAgeDays, setPriceMaxAgeDays] = useState(DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS);
  const [psaPreviewBasePrice, setPsaPreviewBasePrice] = useState('30000');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StoreConfig>('/api/store-config')
      .then((data) => {
        const savedPsa10Rates = data.settings.psa10_discount_rates ?? {};
        const savedBoxRates = data.settings.box_discount_rates ?? {};
        setConfig(data);
        setBoxPriceLowEnabled(data.settings.box_price_low_enabled === true);
        setBoxRates(normalizeBoxRates(savedBoxRates));
        setTokyoSourceRates(normalizeTokyoSourceRates(data.settings.tokyo_source_discount_rates));
        setOutlierGuard({
          max_median_ratio: data.settings.tokyo_outlier_guard?.max_median_ratio ?? DEFAULT_TOKYO_OUTLIER_GUARD.max_median_ratio,
          max_source_price: data.settings.tokyo_outlier_guard?.max_source_price ?? DEFAULT_TOKYO_OUTLIER_GUARD.max_source_price,
        });
        setPriceMaxAgeDays(data.settings.tokyo_price_max_age_days ?? DEFAULT_TOKYO_PRICE_MAX_AGE_DAYS);
        setPsa10Rates(Object.fromEntries(FRANCHISES.map((franchise) => [
          franchise,
          toPercent(savedPsa10Rates[franchise], DEFAULT_PSA10_RATES[franchise]),
        ])) as Psa10Rates);
      })
      .catch((e) => setError(e.message));
  }, []);

  function updatePsa10Rate(franchise: Franchise, value: number) {
    setPsa10Rates((current) => ({
      ...current,
      [franchise]: clampRate(value),
    }));
  }

  function updateBoxRate(franchise: Franchise, key: keyof BoxConditionRates, value: number) {
    setBoxRates((current) => ({
      ...current,
      [franchise]: {
        ...current[franchise],
        [key]: clampRate(value),
      },
    }));
  }

  function updateTokyoSourceRate(source: TokyoPriceSource, key: 'high' | 'low', value: number) {
    setTokyoSourceRates(current => ({ ...current, [source]: { ...current[source], [key]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (config?.store === 'manman-akihabara') {
        for (const source of TOKYO_PRICE_SOURCES) {
          const rates = tokyoSourceRates[source];
          if (!Number.isFinite(rates.high) || rates.high < 0 || rates.high > 100) {
            throw new Error(`${TOKYO_SOURCE_LABELS[source]}の減額率は0〜100%で設定してください`);
          }
        }
        if (!Number.isFinite(outlierGuard.max_median_ratio) || outlierGuard.max_median_ratio < 2 || outlierGuard.max_median_ratio > 1000) {
          throw new Error('外れ値の倍率は2〜1000倍で設定してください');
        }
        if (!Number.isSafeInteger(outlierGuard.max_source_price)
          || outlierGuard.max_source_price < 1000 || outlierGuard.max_source_price > 100000000) {
          throw new Error('外れ値の元価格上限は1,000〜100,000,000円で設定してください');
        }
        if (!Number.isSafeInteger(priceMaxAgeDays) || priceMaxAgeDays < 0 || priceMaxAgeDays > 30) {
          throw new Error('価格の許容経過日数は0〜30日で設定してください');
        }
      }
      const updated = await apiFetch<StoreConfig>('/api/store-config', {
        method: 'PATCH',
        body: JSON.stringify({
          settings: {
            ...(config?.store === 'manman-akihabara' ? { box_price_low_enabled: boxPriceLowEnabled } : {}),
            ...(config?.store === 'manman-akihabara' ? { tokyo_source_discount_rates: Object.fromEntries(
              // 下限減額率は買取表に出ないため画面では扱わない。減額率は大きいほど価格が下がるので
              // 「下限率 >= 上限率」が上限価格 >= 下限価格の条件。保存済みの値を保ち、
              // 画面から触れない値で保存が弾かれないよう、満たさなくなる場合だけ上限率に合わせる。
              TOKYO_PRICE_SOURCES.map(source => [source, {
                high: tokyoSourceRates[source].high / 100,
                low: Math.max(tokyoSourceRates[source].low, tokyoSourceRates[source].high) / 100,
              }]),
            ) } : {}),
            ...(config?.store === 'manman-akihabara'
              ? { tokyo_outlier_guard: outlierGuard, tokyo_price_max_age_days: priceMaxAgeDays } : {}),
            box_discount_rates: Object.fromEntries(FRANCHISES.map((franchise) => [franchise, {
              shrink: boxRates[franchise].shrink / 100,
              ...(CONFIGURABLE_PRICING_FRANCHISES.some(item => item === franchise)
                ? { no_shrink: boxRates[franchise].no_shrink / 100 } : {}),
            }])),
            psa10_discount_rates: Object.fromEntries(CONFIGURABLE_PRICING_FRANCHISES.map((franchise) => [
              franchise,
              psa10Rates[franchise] / 100,
            ])),
          },
        }),
      });
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失敗');
    } finally {
      setSaving(false);
    }
  }

  const previewBoxHigh = 10000;
  const normalizedPsaPreviewBasePrice = normalizePreviewBasePrice(psaPreviewBasePrice);

  return (
    <div>
      <div className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">設定</h1>
        <p className="text-text-secondary mt-2 text-base">ストア設定の管理</p>
      </div>

      <div className="bg-card-bg border border-border-card rounded-2xl p-6 sm:p-8 max-w-3xl">
        {error && (
          <div className="bg-[#fff0ec] border border-[#e3b0a2] text-[#8d3a22] rounded-xl px-4 py-3 mb-6 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-10">
          {config?.store === 'manman-akihabara' && <section>
            <h2 className="text-lg font-bold text-text-primary mb-2">東京比較価格の店舗別減額率</h2>
            <p className="text-sm text-text-secondary mb-6">
              各店舗の元価格へ減額率を適用し、最も高くなった店舗の金額を採用します。
            </p>
            <div className="space-y-5">
              {TOKYO_PRICE_SOURCES.map(source => <div key={source} className="grid gap-3 border-b border-border-card pb-5 last:border-b-0 sm:grid-cols-[1fr_140px] sm:items-end">
                <p className="text-sm font-bold text-text-primary">{TOKYO_SOURCE_LABELS[source]}</p>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-text-secondary">減額率</span>
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={tokyoSourceRates[source].high}
                      onChange={event => updateTokyoSourceRate(source, 'high', Number(event.target.value))}
                      className="w-full rounded-lg border border-border-card bg-transparent px-3 py-2 text-right font-bold text-text-primary focus:outline-none"
                    />
                    <span className="text-text-secondary">%</span>
                  </span>
                </label>
              </div>)}
            </div>
            <h3 className="text-sm font-bold text-text-primary mt-8 mb-2">比較に使う価格の鮮度</h3>
            <p className="text-sm text-text-secondary mb-4">
              各店舗が最後に価格を更新した日から何日前までを比較に入れるかです。0 にすると当日更新分だけを使います。
              広げるほど比較できる商品は増えますが、すでに終了している価格を採用する可能性も上がります。
            </p>
            <label className="block max-w-xs">
              <span className="mb-1 block text-xs font-semibold text-text-secondary">許容する経過日数</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={30}
                  step={1}
                  value={priceMaxAgeDays}
                  onChange={event => setPriceMaxAgeDays(Number(event.target.value))}
                  className="w-full rounded-lg border border-border-card bg-transparent px-3 py-2 text-right font-bold text-text-primary focus:outline-none"
                />
                <span className="text-text-secondary">日前まで</span>
              </span>
            </label>

            <h3 className="text-sm font-bold text-text-primary mt-8 mb-2">外れ値の除外</h3>
            <p className="text-sm text-text-secondary mb-4">
              1店舗だけが異常な元価格を出していた場合に、その店舗を比較から除外します。
              倍率は同一商品の他店舗の元価格の中央値に対する比で判定し、比較相手が無い商品は元価格上限だけで判定します。
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-text-secondary">他店舗中央値に対する上限倍率</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min={2}
                    max={1000}
                    step={1}
                    value={outlierGuard.max_median_ratio}
                    onChange={event => setOutlierGuard(current => ({ ...current, max_median_ratio: Number(event.target.value) }))}
                    className="w-full rounded-lg border border-border-card bg-transparent px-3 py-2 text-right font-bold text-text-primary focus:outline-none"
                  />
                  <span className="text-text-secondary">倍</span>
                </span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-text-secondary">元価格の上限</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1000}
                    max={100000000}
                    step={1000}
                    value={outlierGuard.max_source_price}
                    onChange={event => setOutlierGuard(current => ({ ...current, max_source_price: Number(event.target.value) }))}
                    className="w-full rounded-lg border border-border-card bg-transparent px-3 py-2 text-right font-bold text-text-primary focus:outline-none"
                  />
                  <span className="text-text-secondary">円</span>
                </span>
              </label>
            </div>
          </section>}

          <section className="bg-warm-100 rounded-xl px-5 py-4">
            <h2 className="text-sm font-bold text-text-primary">
              割引後価格の端数処理（BOX上限を除く）
            </h2>
            <p className="text-sm text-text-secondary mt-2">
              元価格に割引率を適用し、その「割引後価格」の金額帯で切り捨てます。元価格の金額帯では判定しません。
            </p>
            <ul className="mt-3 grid gap-1 text-sm text-text-secondary sm:grid-cols-2">
              <li>〜9,999円：100円単位（十の位以下を切り捨て）</li>
              <li>10,000〜99,999円：1,000円単位（百の位以下を切り捨て）</li>
              <li>100,000〜999,999円：10,000円単位（千の位以下を切り捨て）</li>
              <li>1,000,000円〜：100,000円単位（一万の位以下を切り捨て）</li>
            </ul>
            <p className="text-xs text-text-secondary mt-3">
              例: 元価格 ¥105,000・10%引き → 割引後 ¥94,500 → 10万円未満のルールで ¥94,000
            </p>
          </section>

          <section>
            <h2 className="text-lg font-bold text-text-primary mb-6">BOX 割引率</h2>
            <p className="text-sm text-text-secondary mb-6">シュリンク有りはシンソクのS価格に割引率を1回だけ適用し、1,000円未満を切り捨てます。</p>

            {config?.store === 'manman-akihabara' && (
              <label className="mb-8 flex items-start gap-3 rounded-xl border border-border-card px-5 py-4">
                <input
                  type="checkbox"
                  checked={boxPriceLowEnabled}
                  onChange={(event) => setBoxPriceLowEnabled(event.target.checked)}
                  className="mt-1 h-4 w-4 accent-text-primary"
                />
                <span>
                  <span className="block text-sm font-bold text-text-primary">BOXの下限価格を表示</span>
                  <span className="mt-1 block text-xs text-text-secondary">OFFの場合、シュリンク無し価格は「-」で表示します。</span>
                </span>
              </label>
            )}

            <div className="space-y-8">
              {BOX_FRANCHISE_OPTIONS.map(({ key: franchise, label: franchiseLabel }) => {
                const previewBoxShrink = calculateBoxPriceHigh(previewBoxHigh, boxRates[franchise].shrink / 100);
                const previewBoxNoShrink = franchise === 'WEISS SCHWARZ' || franchise === 'DRAGON BALL'
                  ? calculatePelekaAlignedBuyPriceRange(previewBoxHigh).lower
                  : calculateSteppedDiscountPreview(previewBoxHigh, boxRates[franchise].no_shrink);

                return (
                  <div key={franchise} className="border-b border-border-card pb-7 last:border-b-0 last:pb-0">
                    <h3 className="text-sm font-bold text-text-primary mb-4">{franchiseLabel}</h3>

                    <div className="space-y-5">
                      {[
                        { key: 'shrink' as const, label: 'シュリンク有り price_high' },
                        { key: 'no_shrink' as const, label: 'シュリンク無し price_low' },
                      ].filter(({ key }) => key === 'shrink' || CONFIGURABLE_PRICING_FRANCHISES.some(item => item === franchise)).map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
                            {label}
                          </label>
                          <div className="grid gap-3 sm:grid-cols-[1fr_84px] sm:items-center">
                            <input
                              type="range"
                              aria-label={`${franchiseLabel} ${label}の割引率`}
                              min={0}
                              max={50}
                              step={1}
                              value={boxRates[franchise][key]}
                              onChange={(e) => updateBoxRate(franchise, key, Number(e.target.value))}
                              className="h-2 bg-border-card rounded-full appearance-none cursor-pointer accent-text-primary"
                            />
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                aria-label={`${franchiseLabel} ${label}の割引率（数値）`}
                                min={0}
                                max={50}
                                value={boxRates[franchise][key]}
                                onChange={(e) => updateBoxRate(franchise, key, Number(e.target.value))}
                                className="w-14 text-right bg-transparent border border-border-card rounded-lg px-2 py-1 text-text-primary font-bold text-lg focus:outline-none"
                              />
                              <span className="text-text-secondary font-medium">%</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="bg-warm-100 rounded-xl px-5 py-4 text-sm mt-6">
                      <p className="text-text-secondary font-medium mb-2">計算プレビュー（元価格: ¥10,000）</p>
                      <div className="flex justify-between items-baseline">
                        <span className="text-text-secondary">シュリンク有り</span>
                        <span className="text-xl font-bold text-text-primary">¥{previewBoxShrink.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between items-baseline mt-2">
                        <span className="text-text-secondary">シュリンク無し</span>
                        <span className="text-xl font-bold text-text-primary">
                          {config?.store === 'manman-akihabara' && !boxPriceLowEnabled
                            ? '-'
                            : `¥${previewBoxNoShrink.toLocaleString()}`}
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary mt-1">
                        シュリンク有りは1,000円単位。シュリンク無しの既存計算は変更しません。
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="border-t border-border-card pt-8">
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <h2 className="text-lg font-bold text-text-primary">商材別 減額率</h2>
              <label className="block sm:w-48">
                <span className="block text-xs font-semibold text-text-secondary mb-1 uppercase tracking-wide">
                  プレビュー元価格
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary font-medium">¥</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={psaPreviewBasePrice}
                    onChange={(e) => setPsaPreviewBasePrice(e.target.value)}
                    className="w-full text-right bg-transparent border border-border-card rounded-lg px-3 py-2 text-text-primary font-bold text-base focus:outline-none"
                  />
                </div>
              </label>
            </div>

            <div className="space-y-5">
              {FRANCHISE_OPTIONS.map(({ key, label }) => {
                const previewHigh = calculateSteppedDiscountPreview(psaPreviewBasePrice, psa10Rates[key]);

                return (
                  <div key={key}>
                    <label className="block text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
                      {label}
                    </label>
                    <div className="grid gap-3 sm:grid-cols-[1fr_84px_120px] sm:items-center">
                      <input
                        type="range"
                        min={0}
                        max={50}
                        step={1}
                        value={psa10Rates[key]}
                        onChange={(e) => updatePsa10Rate(key, Number(e.target.value))}
                        className="h-2 bg-border-card rounded-full appearance-none cursor-pointer accent-text-primary"
                      />
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={50}
                          value={psa10Rates[key]}
                          onChange={(e) => updatePsa10Rate(key, Number(e.target.value))}
                          className="w-14 text-right bg-transparent border border-border-card rounded-lg px-2 py-1 text-text-primary font-bold text-lg focus:outline-none"
                        />
                        <span className="text-text-secondary font-medium">%</span>
                      </div>
                      <div className="text-sm sm:text-right">
                        <span className="text-text-secondary">
                          ¥{normalizedPsaPreviewBasePrice.toLocaleString()} →{' '}
                        </span>
                        <span className="font-bold text-text-primary">¥{previewHigh.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <button
            onClick={handleSave}
            disabled={saving}
            className={`w-full py-3 rounded-xl font-bold text-base transition-all duration-200 ${
              saving
                ? 'bg-border-card text-text-secondary cursor-not-allowed'
                : saved
                ? 'bg-[#f3faf0] text-[#2d5a2f] border border-[#bfd4b8]'
                : 'bg-text-primary text-white hover:opacity-90 active:scale-[0.98]'
            }`}
          >
            {saving ? '保存中...' : saved ? '保存しました' : '保存'}
          </button>
        </div>

        {config && (
          <p className="text-xs text-text-secondary mt-4">
            ストア: {config.store}
          </p>
        )}
      </div>
    </div>
  );
}
