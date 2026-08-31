import {
  isCustomBuybackCatalogCard,
  planCustomBuybackPages,
  selectCustomLayoutCombination,
  tokyoBusinessDate,
} from '../lib/custom-buyback';

const slots = [1, 2, 3, 4, 6, 8, 9, 12, 15, 20];
const layouts = slots.flatMap((totalSlots) => [
  {
    id: `normal-${totalSlots}`,
    slug: `grid_${totalSlots}`,
    total_slots: totalSlots,
    priority: 0,
    is_active: true,
  },
  {
    id: `box-${totalSlots}`,
    slug: totalSlots === 8 ? 'box_8x5' : `box_${totalSlots}`,
    total_slots: totalSlots,
    priority: 0,
    is_active: true,
  },
]);

describe('custom buyback rules', () => {
  test('Tokyo business date does not drift at UTC midnight', () => {
    expect(tokyoBusinessDate(new Date('2026-08-02T15:30:00.000Z'))).toBe('2026-08-03');
  });

  test('PSA and BOX membership are explicit and price-complete', () => {
    expect(isCustomBuybackCatalogCard({ grade: 'PSA 10', tag: 'TOP', price_high: 1000, price_low: 800 }, 'psa')).toBe(true);
    expect(isCustomBuybackCatalogCard({ grade: null, tag: 'BOX', price_high: 1000, price_low: null }, 'box')).toBe(true);
    expect(isCustomBuybackCatalogCard({ grade: 'PSA10', tag: 'BOX', price_high: 1000, price_low: 800 }, 'psa')).toBe(false);
    expect(isCustomBuybackCatalogCard({ grade: 'PSA10', tag: 'TOP', price_high: 1000, price_low: null }, 'psa')).toBe(false);
  });

  test('PSAとBOXがそれぞれ専用レイアウトから最小ページ数を選ぶ', () => {
    const psa = selectCustomLayoutCombination(41, layouts, 'psa');
    const box = selectCustomLayoutCombination(41, layouts, 'box');
    expect(psa?.map((layout) => layout.total_slots)).toEqual([1, 20, 20]);
    expect(box?.map((layout) => layout.total_slots)).toEqual([1, 20, 20]);
    expect(psa?.every((layout) => !layout.slug.startsWith('box_'))).toBe(true);
    expect(box?.every((layout) => layout.slug.startsWith('box_'))).toBe(true);
  });

  test('page planning preserves the operator order', () => {
    const ids = Array.from({ length: 41 }, (_, index) => `item-${index}`);
    const pages = planCustomBuybackPages(ids, layouts, 'psa');
    expect(pages?.map((page) => page.itemIds.length)).toEqual([1, 20, 20]);
    expect(pages?.flatMap((page) => page.itemIds)).toEqual(ids);
  });
});
