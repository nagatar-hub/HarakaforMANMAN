import type { Franchise } from '../types/franchise.js';

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
