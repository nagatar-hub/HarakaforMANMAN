'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  calculateSteppedDiscountPreview,
  normalizePreviewBasePrice,
} from '@/lib/settings-preview';

type Franchise = 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
type Psa10Rates = Record<Franchise, number>;
type BoxConditionRates = {
  shrink: number;
  no_shrink: number;
};
type BoxRates = Record<Franchise, BoxConditionRates>;

interface StoreConfig {
  store: string;
  settings: {
    box_discount_rates?: Partial<Record<Franchise, Partial<BoxConditionRates>>>;
    psa10_discount_rates?: Partial<Record<Franchise, number>>;
  };
}

const FRANCHISE_OPTIONS: { key: Franchise; label: string }[] = [
  { key: 'Pokemon', label: 'ポケカ' },
  { key: 'YU-GI-OH!', label: '遊戯王' },
  { key: 'ONE PIECE', label: 'ワンピースカード' },
];

const DEFAULT_PSA10_RATES: Psa10Rates = {
  Pokemon: 12,
  'ONE PIECE': 12,
  'YU-GI-OH!': 15,
};

const DEFAULT_BOX_CONDITION_RATES: BoxConditionRates = {
  shrink: 0,
  no_shrink: 15,
};
const DEFAULT_BOX_RATES: BoxRates = {
  Pokemon: { ...DEFAULT_BOX_CONDITION_RATES },
  'ONE PIECE': { ...DEFAULT_BOX_CONDITION_RATES },
  'YU-GI-OH!': { ...DEFAULT_BOX_CONDITION_RATES },
};

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(50, Math.max(0, value));
}

function toPercent(value: number | undefined, fallback: number): number {
  return Math.round((value ?? fallback / 100) * 100);
}

function normalizeBoxRates(savedBoxRates: StoreConfig['settings']['box_discount_rates']): BoxRates {
  return FRANCHISE_OPTIONS.reduce((acc, { key }) => {
    const savedRates = savedBoxRates?.[key] ?? {};
    acc[key] = {
      shrink: toPercent(savedRates.shrink, DEFAULT_BOX_RATES[key].shrink),
      no_shrink: toPercent(savedRates.no_shrink, DEFAULT_BOX_RATES[key].no_shrink),
    };
    return acc;
  }, {} as BoxRates);
}

export default function SettingsPage() {
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [boxRates, setBoxRates] = useState<BoxRates>(DEFAULT_BOX_RATES);
  const [psa10Rates, setPsa10Rates] = useState<Psa10Rates>(DEFAULT_PSA10_RATES);
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
        setBoxRates(normalizeBoxRates(savedBoxRates));
        setPsa10Rates({
          Pokemon: toPercent(savedPsa10Rates.Pokemon, DEFAULT_PSA10_RATES.Pokemon),
          'ONE PIECE': toPercent(savedPsa10Rates['ONE PIECE'], DEFAULT_PSA10_RATES['ONE PIECE']),
          'YU-GI-OH!': toPercent(savedPsa10Rates['YU-GI-OH!'], DEFAULT_PSA10_RATES['YU-GI-OH!']),
        });
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

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await apiFetch<StoreConfig>('/api/store-config', {
        method: 'PATCH',
        body: JSON.stringify({
          settings: {
            box_discount_rates: {
              Pokemon: {
                shrink: boxRates.Pokemon.shrink / 100,
                no_shrink: boxRates.Pokemon.no_shrink / 100,
              },
              'ONE PIECE': {
                shrink: boxRates['ONE PIECE'].shrink / 100,
                no_shrink: boxRates['ONE PIECE'].no_shrink / 100,
              },
              'YU-GI-OH!': {
                shrink: boxRates['YU-GI-OH!'].shrink / 100,
                no_shrink: boxRates['YU-GI-OH!'].no_shrink / 100,
              },
            },
            psa10_discount_rates: {
              Pokemon: psa10Rates.Pokemon / 100,
              'ONE PIECE': psa10Rates['ONE PIECE'] / 100,
              'YU-GI-OH!': psa10Rates['YU-GI-OH!'] / 100,
            },
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
          <section>
            <h2 className="text-lg font-bold text-text-primary mb-6">BOX 割引率</h2>

            <div className="space-y-8">
              {FRANCHISE_OPTIONS.map(({ key: franchise, label: franchiseLabel }) => {
                const previewBoxShrink = calculateSteppedDiscountPreview(previewBoxHigh, boxRates[franchise].shrink);
                const previewBoxNoShrink = calculateSteppedDiscountPreview(previewBoxHigh, boxRates[franchise].no_shrink);

                return (
                  <div key={franchise} className="border-b border-border-card pb-7 last:border-b-0 last:pb-0">
                    <h3 className="text-sm font-bold text-text-primary mb-4">{franchiseLabel}</h3>

                    <div className="space-y-5">
                      {[
                        { key: 'shrink' as const, label: 'シュリンク有り price_high' },
                        { key: 'no_shrink' as const, label: 'シュリンク無し price_low' },
                      ].map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
                            {label}
                          </label>
                          <div className="grid gap-3 sm:grid-cols-[1fr_84px] sm:items-center">
                            <input
                              type="range"
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
                        <span className="text-xl font-bold text-text-primary">¥{previewBoxNoShrink.toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-text-secondary mt-1">
                        それぞれ元価格に割引率を適用し、100円単位で切り捨て
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
