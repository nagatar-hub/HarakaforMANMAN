import type { CustomBuybackItemRow } from '@haraka/shared';
import { customBuybackCsv, reorderCustomBuybackItems, safeDownloadName } from '../app/custom-buyback/custom-buyback-state';

function item(id: string, position: number): CustomBuybackItemRow {
  return {
    id, sheet_id: 'sheet', source_prepared_card_id: null, source_kaitori_product_id: 123,
    source_kaitori_condition_id: 1, source_kaitori_shop_id: 2, source_kaitori_edition_id: null,
    source_shop_name: '最高買取店', source_db_card_id: null, excel_product_id: `excel-${id}`,
    position, card_name: `カード,${id}`, grade: 'PSA10', list_no: '001', rarity: 'SAR', rarity_icon_url: null,
    tag: null, image_url: null, alt_image_url: null, image_status: 'ok', source_price_high: 1000,
    source_price_low: null, final_price_high: 1200, final_price_low: null, demand: 7, price_source: 'kaitori_checker',
    price_source_date: '2026-08-03', override_reason: '"強化"', created_at: '', updated_at: '',
  };
}

test('reorder requires the exact unique item set and rewrites positions', () => {
  expect(reorderCustomBuybackItems([item('a', 0), item('b', 1)], ['b', 'a']).map((row) => [row.id, row.position]))
    .toEqual([['b', 0], ['a', 1]]);
  expect(() => reorderCustomBuybackItems([item('a', 0), item('b', 1)], ['a', 'a'])).toThrow();
});

test('CSV includes BOM and safely quotes commas and double quotes', () => {
  const csv = customBuybackCsv([item('a', 0)]);
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('"元価格","表示価格","募集数"');
  expect(csv).toContain('"カード,a"');
  expect(csv).toContain('"1000","1200","7","最高買取店"');
  expect(csv).toContain('"2026-08-03","123","excel-a"');
  expect(csv).toContain('"""強化"""');
});

test('download names exclude Windows-invalid characters', () => {
  expect(safeDownloadName('8/3: PSA*')).toBe('8_3_ PSA_');
});
