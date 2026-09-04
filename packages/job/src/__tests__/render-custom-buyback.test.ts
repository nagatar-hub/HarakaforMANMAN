import type { CustomBuybackItemRow, CustomBuybackSheetRow } from '@haraka/shared';
import { customBuybackDisplayDateText, customItemToPreparedCard } from '../jobs/render-custom-buyback.js';

const sheet = {
  id: 'sheet-1', store: 'oripark', name: 'custom', franchise: 'Pokemon', product_type: 'psa', kind: 'store',
  catalog_source: 'prepared_card', price_snapshot_run_id: 'run-1', kaitori_checker_run_id: null,
  kaitori_checker_source_store: null,
  price_business_date: '2026-08-03', display_date: '2026-08-05', status: 'draft', revision: 0,
  last_rendered_revision: null, error_message: null, created_by: null, created_at: '', updated_at: '',
} satisfies CustomBuybackSheetRow;

const item = {
  id: 'item-1', sheet_id: sheet.id, source_prepared_card_id: 'prepared-1', source_db_card_id: 'db-1',
  source_kaitori_product_id: null, source_kaitori_condition_id: null, source_kaitori_shop_id: null,
  source_kaitori_edition_id: null, source_shop_name: null,
  excel_product_id: 'excel-1', position: 0, card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001',
  rarity: 'SAR', rarity_icon_url: null, tag: null, image_url: 'https://example.com/card.png', alt_image_url: null,
  image_status: 'ok', source_price_high: 10000, source_price_low: 8000, final_price_high: 12500,
  final_price_low: 9500, demand: 3, price_source: 'order_list', price_source_date: '2026-08-03', override_reason: '強化',
  created_at: '', updated_at: '',
} satisfies CustomBuybackItemRow;

test('custom renderer passes manual display prices into the existing compositor shape', () => {
  const prepared = customItemToPreparedCard(item, sheet);
  expect(prepared.id).toBe(item.id);
  expect(prepared.price_high).toBe(12500);
  expect(prepared.price_low).toBeNull();
  expect(prepared.source).toBe('manual');
  expect(prepared.run_id).toBe('run-1');
});

test('BOX output never passes a low price to the compositor', () => {
  const prepared = customItemToPreparedCard(item, { ...sheet, product_type: 'box' });
  expect(prepared.price_high).toBe(12500);
  expect(prepared.price_low).toBeNull();
});

test('Kaitori Checker snapshots use their own run without leaking the source enum into prepared cards', () => {
  const prepared = customItemToPreparedCard({ ...item, price_source: 'kaitori_checker' }, {
    ...sheet, catalog_source: 'kaitori_checker', price_snapshot_run_id: null,
    kaitori_checker_run_id: 'kaitori-run-1', kaitori_checker_source_store: 'oripark',
  });
  expect(prepared.run_id).toBe('kaitori-run-1');
  expect(prepared.price_source).toBe('manual');
});

test('custom renderer prints the editable display date, not the price source date', () => {
  expect(customBuybackDisplayDateText(sheet.display_date)).toBe('08/05');
  expect(sheet.display_date).not.toBe(sheet.price_business_date);
});
