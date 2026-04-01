'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';

interface StoreConfig {
  store: string;
  settings: {
    box_shrink_discount_rate?: number;
  };
}

export default function SettingsPage() {
  const [config, setConfig] = useState<StoreConfig | null>(null);
  const [discountRate, setDiscountRate] = useState<number>(15);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<StoreConfig>('/api/store-config')
      .then((data) => {
        setConfig(data);
        setDiscountRate(Math.round((data.settings.box_shrink_discount_rate ?? 0.15) * 100));
      })
      .catch((e) => setError(e.message));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await apiFetch<StoreConfig>('/api/store-config', {
        method: 'PATCH',
        body: JSON.stringify({ settings: { box_shrink_discount_rate: discountRate / 100 } }),
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

  const previewHigh = 10000;
  const previewLow = Math.floor(previewHigh * (1 - discountRate / 100) / 100) * 100;

  return (
    <div>
      <div className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-text-primary">設定</h1>
        <p className="text-text-secondary mt-2 text-base">ストア設定の管理</p>
      </div>

      <div className="bg-card-bg border border-border-card rounded-2xl p-6 sm:p-8 max-w-lg">
        <h2 className="text-lg font-bold text-text-primary mb-6">BOX シュリンク無し割引率</h2>

        {error && (
          <div className="bg-[#fff0ec] border border-[#e3b0a2] text-[#8d3a22] rounded-xl px-4 py-3 mb-6 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
              割引率
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={0}
                max={50}
                step={1}
                value={discountRate}
                onChange={(e) => setDiscountRate(Number(e.target.value))}
                className="flex-1 h-2 bg-border-card rounded-full appearance-none cursor-pointer accent-text-primary"
              />
              <div className="flex items-center gap-1 min-w-[72px]">
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={discountRate}
                  onChange={(e) => setDiscountRate(Math.min(50, Math.max(0, Number(e.target.value))))}
                  className="w-14 text-right bg-transparent border border-border-card rounded-lg px-2 py-1 text-text-primary font-bold text-lg focus:outline-none"
                />
                <span className="text-text-secondary font-medium">%</span>
              </div>
            </div>
          </div>

          <div className="bg-warm-100 rounded-xl px-5 py-4 text-sm">
            <p className="text-text-secondary font-medium mb-2">計算プレビュー（シュリンク有: ¥10,000）</p>
            <div className="flex justify-between items-baseline">
              <span className="text-text-secondary">シュリンク無し</span>
              <span className="text-xl font-bold text-text-primary">¥{previewLow.toLocaleString()}</span>
            </div>
            <p className="text-xs text-text-secondary mt-1">
              floor(10,000 × {((1 - discountRate / 100)).toFixed(2)} / 100) × 100
            </p>
          </div>

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
            {saving ? '保存中...' : saved ? '✓ 保存しました' : '保存'}
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
