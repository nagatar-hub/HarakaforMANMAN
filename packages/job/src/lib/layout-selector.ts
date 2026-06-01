/**
 * レイアウト組合せセレクタ
 *
 * グループ枚数 N に対して、利用可能なレイアウト候補（枠数の多重集合）から
 * 最適な組合せを動的計画法で選ぶ。
 *
 * 優先順位（高い順）：
 *   1. ページ数最小：|choice| を最小化（できるだけ単ページに収める）
 *   2. オーバーシュート（余剰）最小：sum(choice) - N を最小化
 *   3. 辞書順最小（昇順ソート時）：`[2,6]` を `[4,4]` より優先（小枠を含む組合せを好む）
 *
 * 余剰スロットは呼び出し側（image-composer）でカード裏面で埋める前提のため、
 * ページ数最小を最優先する。複数ページに分割するより 1 枚で完結したほうが
 * 紙面の見栄えが整う。
 *
 * 例（候補 {1, 2, 4, 6, 9, 15, 20, 40}）：
 *   N=3  → [4]         （単ページ、余剰 1）
 *   N=5  → [6]         （単ページ、余剰 1）
 *   N=8  → [9]         （単ページ、余剰 1）
 *   N=11 → [15]        （単ページ、余剰 4）
 *   N=17 → [20]        （単ページ、余剰 3）
 *   N=41 → [1, 40]     （2 ページ、余剰 0；単ページ不可）
 *   N=62 → [40, 40]    （2 ページ、余剰 18）
 *   N=100 → [20,40,40] （3 ページ、余剰 0）
 */

import type { LayoutTemplateRow } from '@haraka/shared';

/**
 * 1 組合せ分の選択結果。`layouts` は slots 昇順。
 */
export interface LayoutCombination<L extends { total_slots: number }> {
  layouts: L[];
  totalSlots: number;
  overshoot: number;   // sum - N
  pageCount: number;   // = layouts.length
}

/**
 * 利用可能レイアウト一覧から N 枚に対する最適組合せを求める。
 *
 * 同一 `total_slots` のレイアウトが複数ある場合、`priority` 降順で 1 件を代表として採用。
 *
 * candidates が空 or 適合候補が無い場合 `null`。
 */
export function selectLayoutCombination<L extends LayoutTemplateRow>(
  n: number,
  candidates: L[],
): LayoutCombination<L> | null {
  if (n <= 0) return { layouts: [], totalSlots: 0, overshoot: 0, pageCount: 0 };
  if (candidates.length === 0) return null;

  // 同一 slots のレイアウトは priority 降順で 1 件だけ採用
  const bySlot = new Map<number, L>();
  for (const c of candidates) {
    if (!c.is_active) continue;
    if (c.total_slots <= 0) continue;
    const existing = bySlot.get(c.total_slots);
    if (!existing || (c.priority ?? 0) > (existing.priority ?? 0)) {
      bySlot.set(c.total_slots, c);
    }
  }

  const sizes = [...bySlot.keys()].sort((a, b) => a - b);
  if (sizes.length === 0) return null;

  const maxSlot = sizes[sizes.length - 1];
  const upperBound = n + maxSlot;

  // DP：dp[s] = 合計 s を実現する最良の multiset（Array<number>、size 昇順）
  //            存在しなければ null。
  // 各 s に対する「最良」= ページ数最小 → 辞書順最小（昇順ソート時）。
  const dp: (number[] | null)[] = new Array(upperBound + 1).fill(null);
  dp[0] = [];

  for (let s = 1; s <= upperBound; s++) {
    let best: number[] | null = null;
    for (const v of sizes) {
      if (v > s) break;
      const prev = dp[s - v];
      if (!prev) continue;
      // 新組合せ = prev に v を追加して昇順に保つ。
      const candidate = insertSorted(prev, v);
      if (!best || isBetter(candidate, best)) best = candidate;
    }
    dp[s] = best;
  }

  // s ∈ [N, upperBound] を全走査し、(pageCount, overshoot) の辞書順最小を選択。
  // s は昇順走査なので、同じ pageCount 内では最初に見つかった s が最小余剰になる。
  let bestCombo: number[] | null = null;
  let bestS = -1;
  for (let s = n; s <= upperBound; s++) {
    const combo = dp[s];
    if (!combo) continue;
    if (!bestCombo || combo.length < bestCombo.length) {
      bestCombo = combo;
      bestS = s;
    }
  }

  if (!bestCombo) return null;

  const layouts = bestCombo.map(slot => bySlot.get(slot)!);
  return {
    layouts,
    totalSlots: bestS,
    overshoot: bestS - n,
    pageCount: bestCombo.length,
  };
}

/**
 * 昇順を保ったまま要素を追加
 */
function insertSorted(arr: number[], v: number): number[] {
  const out = [...arr];
  let i = out.length - 1;
  while (i >= 0 && out[i] > v) i--;
  out.splice(i + 1, 0, v);
  return out;
}

/**
 * a のほうが「より良い」組合せか判定（ページ数少ない → 辞書順小）
 * 前提：a, b ともに昇順ソート済み
 */
function isBetter(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}
