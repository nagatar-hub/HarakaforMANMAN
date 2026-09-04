import type { CustomBuybackItemRow } from '@haraka/shared';
import { catalogSearchParams, customBuybackCsv, isCatalogPriceRangeValid, reorderCustomBuybackItems, safeDownloadName } from '../app/custom-buyback/custom-buyback-state';

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

test('catalog filters map to API parameters and reject an inverted price range', () => {
  expect(catalogSearchParams({ q: 'リザードン', minPrice: '1000', maxPrice: '5000', sort: 'price_desc' }).toString())
    .toBe('q=%E3%83%AA%E3%82%B6%E3%83%BC%E3%83%89%E3%83%B3&sort=price_desc&min_price=1000&max_price=5000');
  expect(isCatalogPriceRangeValid({ q: '', minPrice: '5001', maxPrice: '5000', sort: 'price_asc' })).toBe(false);
});

test.each(['-1', '1.5', '100000001'])('catalog price rejects invalid API-bound value %s', (value) => {
  expect(isCatalogPriceRangeValid({ q: '', minPrice: value, maxPrice: '', sort: 'price_desc' })).toBe(false);
  expect(isCatalogPriceRangeValid({ q: '', minPrice: '', maxPrice: value, sort: 'price_desc' })).toBe(false);
});

test('catalog price accepts empty values and inclusive API boundaries', () => {
  expect(isCatalogPriceRangeValid({ q: '', minPrice: '', maxPrice: '', sort: 'price_desc' })).toBe(true);
  expect(isCatalogPriceRangeValid({ q: '', minPrice: '0', maxPrice: '100000000', sort: 'price_desc' })).toBe(true);
});
