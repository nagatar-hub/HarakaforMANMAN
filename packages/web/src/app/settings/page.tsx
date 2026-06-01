'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

type Franchise = 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!';
type Psa10Rates = Record<Franchise, number>;
type BoxRates = {
  shrink: number;
  no_shrink: number;
};

interface StoreConfig {
  store: string;
  settings: {
    buy_price_high_discount_rate?: number;
    box_discount_rates?: Partial<Record<keyof BoxRates, number>>;
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

const DEFAULT_BOX_RATES: BoxRates = {
  shrink: 0,
  no_shrink: 15,
};
const DEFAULT_BUY_PRICE_HIGH_RATE = 15;

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(50, Math.max(0, value));
}

function toPercent(value: number | undefined, fallback: number): number {
  return Math.round((value ?? fallback / 100) * 100);
}

function niceLowerBound(raw: number): number {
  const steps =
    raw < 10000 ? [500] :
    raw < 100000 ? [1000, 2000, 5000] :
    raw < 300000 ? [5000, 10000] :
    [10000, 20000, 50000];

  let bestValue = 0;
  let bestDiff = Infinity;
  let bestStep = 0;

  for (const step of steps) {
    const value = Math.floor(raw / step) * step;
    const diff = raw - value;
    if (diff < bestDiff || (diff === bestDiff && step > bestStep)) {
      bestValue = value;
      bestDiff = diff;
      bestStep = step;
    }
  }

  return bestValue;
}

export default function SettingsPage() {
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [buyPriceHighRate, setBuyPriceHighRate] = useState<number>(DEFAULT_BUY_PRICE_HIGH_RATE);
  const [boxRates, setBoxRates] = useState<BoxRates>(DEFAULT_BOX_RATES);
  const [psa10Rates, setPsa10Rates] = useState<Psa10Rates>(DEFAULT_PSA10_RATES);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StoreConfig>('/api/store-config')
      .then((data) => {
        const savedPsa10Rates = data.settings.psa10_discount_rates ?? {};
        const savedBoxRates = data.settings.box_discount_rates ?? {};
        setConfig(data);
        setBuyPriceHighRate(toPercent(data.settings.buy_price_high_discount_rate, DEFAULT_BUY_PRICE_HIGH_RATE));
        setBoxRates({
          shrink: toPercent(savedBoxRates.shrink, DEFAULT_BOX_RATES.shrink),
          no_shrink: toPercent(savedBoxRates.no_shrink, DEFAULT_BOX_RATES.no_shrink),
        });
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

  function updateBoxRate(key: keyof BoxRates, value: number) {
    setBoxRates((current) => ({
      ...current,
      [key]: clampRate(value),
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
            buy_price_high_discount_rate: buyPriceHighRate / 100,
            box_discount_rates: {
              shrink: boxRates.shrink / 100,
              no_shrink: boxRates.no_shrink / 100,
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
  const previewBuyPriceHigh = Math.floor(previewBoxHigh * (1 - buyPriceHighRate / 100) / 100) * 100;
  const previewBoxShrink = Math.floor(previewBoxHigh * (1 - boxRates.shrink / 100) / 100) * 100;
  const previewBoxNoShrink = Math.floor(previewBoxHigh * (1 - boxRates.no_shrink / 100) / 100) * 100;
  const previewPsaHigh = 30000;

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
            <h2 className="text-lg font-bold text-text-primary mb-6">買取上限減額率</h2>

            <div>
              <label className="block text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
                減額率
              </label>
              <div className="grid gap-3 sm:grid-cols-[1fr_84px] sm:items-center">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={buyPriceHighRate}
                  onChange={(e) => setBuyPriceHighRate(clampRate(Number(e.target.value)))}
                  className="h-2 bg-border-card rounded-full appearance-none cursor-pointer accent-text-primary"
                />
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={buyPriceHighRate}
                    onChange={(e) => setBuyPriceHighRate(clampRate(Number(e.target.value)))}
                    className="w-14 text-right bg-transparent border border-border-card rounded-lg px-2 py-1 text-text-primary font-bold text-lg focus:outline-none"
                  />
                  <span className="text-text-secondary font-medium">%</span>
                </div>
              </div>
            </div>

            <div className="bg-warm-100 rounded-xl px-5 py-4 text-sm mt-6">
              <p className="text-text-secondary font-medium mb-2">計算プレビュー（元価格: ¥10,000）</p>
              <div className="flex justify-between items-baseline">
                <span className="text-text-secondary">買取上限</span>
                <span className="text-xl font-bold text-text-primary">¥{previewBuyPriceHigh.toLocaleString()}</span>
              </div>
              <p className="text-xs text-text-secondary mt-1">
                元価格に減額率を適用し、100円単位で切り捨て
              </p>
            </div>
          </section>

          <section className="border-t border-border-card pt-8">
            <h2 className="text-lg font-bold text-text-primary mb-6">BOX 割引率</h2>

            <div className="space-y-5">
              {[
                { key: 'shrink' as const, label: 'シュリンク有り' },
                { key: 'no_shrink' as const, label: 'シュリンク無し' },
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
                      value={boxRates[key]}
                      onChange={(e) => updateBoxRate(key, Number(e.target.value))}
                      className="h-2 bg-border-card rounded-full appearance-none cursor-pointer accent-text-primary"
                    />
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={50}
                        value={boxRates[key]}
                        onChange={(e) => updateBoxRate(key, Number(e.target.value))}
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
          </section>

          <section className="border-t border-border-card pt-8">
            <h2 className="text-lg font-bold text-text-primary mb-6">PSA10 減額率</h2>

            <div className="space-y-5">
              {FRANCHISE_OPTIONS.map(({ key, label }) => {
                const previewLow = niceLowerBound(previewPsaHigh * (1 - psa10Rates[key] / 100));

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
                        <span className="text-text-secondary">¥30,000 → </span>
                        <span className="font-bold text-text-primary">¥{previewLow.toLocaleString()}</span>
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
