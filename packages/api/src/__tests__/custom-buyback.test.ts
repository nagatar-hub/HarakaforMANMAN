import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  applyCustomBuybackBulkPrice,
  buildCustomBuybackCatalogOrFilter,
  customBuybackRoutes,
  matchCustomBuybackRefreshCards,
  parseCustomBuybackCreate,
  parseCustomBuybackPricePatch,
  parseCustomBuybackSheetPatch,
} from '../routes/custom-buyback.js';

const originalToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  else process.env.ORDER_LIST_IMPORT_API_TOKEN = originalToken;
});

test('custom buyback API fails closed without the internal token', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await customBuybackRoutes.request('/custom-buyback/sheets');
  assert.equal(response.status, 503);
});

test('custom buyback API rejects an invalid bearer token', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  const response = await customBuybackRoutes.request('/custom-buyback/sheets', {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(response.status, 401);
});

test('sheet create input is normalized and constrained', () => {
  assert.deepEqual(parseCustomBuybackCreate({
    name: ' 8月3日 PSA ', franchise: 'Pokemon', product_type: 'psa', kind: 'store', display_date: '2026-08-05',
  }), {
    ok: true,
    value: { name: '8月3日 PSA', franchise: 'Pokemon', productType: 'psa', kind: 'store', displayDate: '2026-08-05' },
  });
  assert.equal(parseCustomBuybackCreate({
    name: 'bad', franchise: 'Pokemon', product_type: 'sealed', kind: 'store',
  }).ok, false);
});

test('sheet date patch accepts real calendar dates and rejects impossible dates', () => {
  assert.deepEqual(parseCustomBuybackSheetPatch({ display_date: '2026-08-31' }), {
    ok: true,
    value: { displayDate: '2026-08-31' },
  });
  assert.equal(parseCustomBuybackSheetPatch({ display_date: '2026-02-31' }).ok, false);
  assert.equal(parseCustomBuybackSheetPatch({}).ok, false);
});

test('BOX ignores a low price while PSA requires one', () => {
  assert.deepEqual(parseCustomBuybackPricePatch({ final_price_high: 12000 }, 'box'), {
    ok: true,
    value: { finalPriceHigh: 12000, finalPriceLow: null, overrideReason: null, reset: false },
  });
  assert.equal(parseCustomBuybackPricePatch({ final_price_high: 12000 }, 'psa').ok, false);
});

test('bulk price helpers support add, percent, round, and reset without negatives', () => {
  const item = {
    source_price_high: 10000,
    source_price_low: 8000,
    final_price_high: null,
    final_price_low: null,
  };
  assert.deepEqual(applyCustomBuybackBulkPrice(item, 'add', -500, 'psa'), { high: 9500, low: 7500 });
  assert.deepEqual(applyCustomBuybackBulkPrice(item, 'percent', 10, 'psa'), { high: 11000, low: 8800 });
  assert.deepEqual(applyCustomBuybackBulkPrice({ ...item, final_price_high: 10240 }, 'round', 500, 'box'), { high: 10000, low: null });
  assert.deepEqual(applyCustomBuybackBulkPrice(item, 'reset', 0, 'psa'), { high: 10000, low: 8000 });
});

test('price refresh matches stable Excel IDs and rejects duplicate target cards', () => {
  const candidate = {
    id: 'new-1', db_card_id: 'db-1', excel_product_id: 'excel-1', franchise: 'Pokemon',
    card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001', rarity: 'SAR', rarity_icon_url: null,
    tag: null, image_url: null, alt_image_url: null, image_status: 'ok',
    price_high: 12000, price_low: 10000, price_source: 'order_list', price_source_date: '2026-08-03',
  } as const;
  assert.deepEqual(matchCustomBuybackRefreshCards([
    { id: 'item-1', source_db_card_id: 'db-1', excel_product_id: 'excel-1', card_name: '旧名でも可', grade: 'PSA10', list_no: '001' },
  ], [candidate]), { ok: true, itemIds: ['item-1'], preparedCardIds: ['new-1'] });
  assert.deepEqual(matchCustomBuybackRefreshCards([
    { id: 'item-1', source_db_card_id: 'db-1', excel_product_id: 'excel-1', card_name: 'A', grade: 'PSA10', list_no: '001' },
    { id: 'item-2', source_db_card_id: 'db-1', excel_product_id: 'excel-1', card_name: 'B', grade: 'PSA10', list_no: '002' },
  ], [candidate]), { ok: false, unmatched: ['B'] });
});

test('catalog search quotes PostgREST OR values before composing fields', () => {
  const filter = buildCustomBuybackCatalogOrFilter(' ピカチュウ",SAR\\ ');
  assert.match(filter, /^card_name\.ilike\."%ピカチュウ\\",SAR\\\\%"/);
  assert.equal(filter.match(/\.ilike\./g)?.length, 6);
});
