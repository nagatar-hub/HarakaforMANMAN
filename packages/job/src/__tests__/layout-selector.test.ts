/**
 * layout-selector のユニットテスト
 */

import { selectLayoutCombination } from '../lib/layout-selector';
import type { LayoutTemplateRow, LayoutConfig } from '@haraka/shared';

function makeLayout(slots: number, overrides: Partial<LayoutTemplateRow> = {}): LayoutTemplateRow {
  const minimalLayoutConfig: LayoutConfig = {
    startX: 0, priceStartX: 0, colWidth: 0, cardWidth: 0, cardHeight: 0,
    isSmallCard: false, rows: [],
    priceBoxWidth: 0, priceBoxHeight: 0,
    dateX: 0, dateY: 0,
  };
  return {
    id: `layout-${slots}`,
    store: 'oripark',
    kind: 'postal',
    franchise: 'Pokemon',
    name: `${slots}枠`,
    slug: `grid_${slots}`,
    grid_cols: 1,
    grid_rows: slots,
    total_slots: slots,
    img_width: 1240,
    img_height: 1760,
    template_storage_path: `templates/pokemon/${slots}.png`,
    card_back_storage_path: 'card-backs/pokemon.png',
    layout_config: minimalLayoutConfig,
    skip_price_low: false,
    is_default: slots === 40,
    is_active: true,
    priority: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const FULL_SET = [1, 2, 4, 6, 9, 15, 20, 40].map(n => makeLayout(n));
const MANMAN_SET = [1, 2, 4, 6, 8, 9, 15, 16, 24].map(n => makeLayout(n));

describe('selectLayoutCombination', () => {
  // ------- 基本ケース -------

  test('N=0 は空の組合せ', () => {
    const r = selectLayoutCombination(0, FULL_SET);
    expect(r).toEqual({ layouts: [], totalSlots: 0, overshoot: 0, pageCount: 0 });
  });

  test('候補が空なら null', () => {
    expect(selectLayoutCombination(10, [])).toBeNull();
  });

  // ------- 主要ケース（単ページ最優先） -------

  test('N=11 → [15]（単ページ優先、余剰 4）', () => {
    const r = selectLayoutCombination(11, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([15]);
    expect(r.overshoot).toBe(4);
    expect(r.pageCount).toBe(1);
  });

  test('N=13 → [15]（単ページ優先、余剰 2）', () => {
    const r = selectLayoutCombination(13, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([15]);
    expect(r.overshoot).toBe(2);
  });

  test('N=17 → [20]（単ページ優先、余剰 3）', () => {
    const r = selectLayoutCombination(17, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([20]);
    expect(r.overshoot).toBe(3);
  });

  test('N=41 → [1, 40]（単ページ不可、2 ページで余剰 0）', () => {
    const r = selectLayoutCombination(41, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([1, 40]);
    expect(r.overshoot).toBe(0);
  });

  test('N=62 → [40, 40]（pc=2 が最優先、余剰 18）', () => {
    const r = selectLayoutCombination(62, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([40, 40]);
    expect(r.overshoot).toBe(18);
    expect(r.pageCount).toBe(2);
  });

  // ------- ぴったり・少数・100枚 -------

  test('N=1 → [1]', () => {
    const r = selectLayoutCombination(1, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([1]);
  });

  test('N=3 → [4]（単ページ、余剰 1）', () => {
    const r = selectLayoutCombination(3, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([4]);
    expect(r.overshoot).toBe(1);
  });

  test('N=5 → [6]（単ページ、余剰 1）', () => {
    const r = selectLayoutCombination(5, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([6]);
    expect(r.overshoot).toBe(1);
  });

  test('N=7 → [9]（単ページ、余剰 2）', () => {
    const r = selectLayoutCombination(7, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([9]);
    expect(r.overshoot).toBe(2);
  });

  test('N=8 → [9]（単ページ、余剰 1）', () => {
    const r = selectLayoutCombination(8, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([9]);
    expect(r.overshoot).toBe(1);
  });

  test('MANMAN N=7 → [8]（8枠テンプレートを選ぶ）', () => {
    const r = selectLayoutCombination(7, MANMAN_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([8]);
    expect(r.overshoot).toBe(1);
  });

  test('MANMAN N=16 → [16]（原稿20の16枠テンプレートを選ぶ）', () => {
    const r = selectLayoutCombination(16, MANMAN_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([16]);
    expect(r.overshoot).toBe(0);
  });

  test('MANMAN N=17 → [24]（原稿40の24枠テンプレートを選ぶ）', () => {
    const r = selectLayoutCombination(17, MANMAN_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([24]);
    expect(r.overshoot).toBe(7);
  });

  test('N=100 → [20, 40, 40]（3 ページが最小、余剰 0）', () => {
    const r = selectLayoutCombination(100, FULL_SET)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([20, 40, 40]);
    expect(r.overshoot).toBe(0);
  });

  // ------- 余剰ありケース -------

  test('候補 {4, 9} のみ、N=11 → [4, 9]（pc=2 が pc=3 に勝つ）', () => {
    // [4, 9] は sum 13 / overshoot 2 / pc=2
    // [4, 4, 4] は sum 12 / overshoot 1 / pc=3
    // ページ数最小ルールで [4, 9] が勝つ。
    const limited = [4, 9].map(n => makeLayout(n));
    const r = selectLayoutCombination(11, limited)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([4, 9]);
    expect(r.overshoot).toBe(2);
    expect(r.pageCount).toBe(2);
  });

  test('候補 {10} のみ、N=25 → [10, 10, 10]（余剰 5）', () => {
    const limited = [makeLayout(10)];
    const r = selectLayoutCombination(25, limited)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([10, 10, 10]);
    expect(r.overshoot).toBe(5);
    expect(r.pageCount).toBe(3);
  });

  // ------- is_active / priority -------

  test('is_active=false のレイアウトは除外', () => {
    const mixed = FULL_SET.map((l, i) => i === 3 ? { ...l, is_active: false } : l);
    // 6 枠を無効化。N=8 で 6 が使えず [9]（単ページ、余剰 1）が選ばれる。
    const r = selectLayoutCombination(8, mixed)!;
    expect(r.layouts.map(l => l.total_slots)).toEqual([9]);
  });

  test('同一 slots では priority 高い方が採用される', () => {
    const primary = makeLayout(20, { id: 'primary', priority: 10, name: 'primary' });
    const secondary = makeLayout(20, { id: 'secondary', priority: 0, name: 'secondary' });
    const r = selectLayoutCombination(20, [primary, secondary])!;
    expect(r.layouts).toHaveLength(1);
    expect(r.layouts[0].id).toBe('primary');
  });

  // ------- 並び順 -------

  test('返り値の layouts は slots 昇順', () => {
    const r = selectLayoutCombination(62, FULL_SET)!;
    const sizes = r.layouts.map(l => l.total_slots);
    const sorted = [...sizes].sort((a, b) => a - b);
    expect(sizes).toEqual(sorted);
  });
});
