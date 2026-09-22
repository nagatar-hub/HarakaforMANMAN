import { normalizeStorePricingSettings } from '@haraka/shared';
import {
  compareTokyoSourceProducts, runTokyoBuybackSync, tokyoDisplayPrice, tokyoProductCandidates,
} from '../jobs/tokyo-buyback-sync';
import type { ShinsokuPostalProduct } from '@haraka/shared';

const SETTINGS = normalizeStorePricingSettings({});
const OBSERVED_AT = '2026-09-09T05:00:00.000Z';
const OFFICIAL: ShinsokuPostalProduct = { id: 'IAP1', franchise: 'Pokemon', name: 'カイ',
  modelNumber: '236/172', productType: 'PSA10', price: 100000, imageUrl: 'official.jpg' };

test('lineup union covers KECAK and the three checker shops, each carrying its own price', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'unmatched', source_price: 70000 },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '素体', list_no: '1', grade: 'S', match_status: 'matched', source_price: 1 },
    { id: 'k3', excel_product_id: 'k3', franchise: 'WEISS SCHWARZ', card_name: '旧KECAKヴァイス', list_no: '1', grade: 'PSA10', match_status: 'matched', source_price: 80000 },
    { id: 'ky', excel_product_id: 'ky', franchise: 'YU-GI-OH!', card_name: 'KECAK遊戯除外', list_no: 'Y/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
  ], [
    { source_product_id: 2, category: 'pokemon', name: 'バンクのみ', full_name: null, model_number: '2' },
    { source_product_id: 3, category: 'one_piece', name: 'アヴィリールのみ', full_name: null, model_number: null },
  ], [
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: 9000 },
    { source_product_id: 3, shop_id: 13, condition_id: 2, edition_id: 0, buy_price: 8000 },
    { source_product_id: 2, shop_id: 11, condition_id: 1, edition_id: 0, buy_price: 9500 },
    { source_product_id: 2, shop_id: 22, condition_id: 1, edition_id: 0 },
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0 },
  ]);
  expect(candidates.map(row => row.source)).toEqual(['kecak', 'kecak', 'toreca_bank', 'avirile', 'blue_rocket']);
  expect(candidates.map(row => row.productType)).toEqual(['PSA10', 'PSA10', 'PSA10', 'BOX', 'PSA10']);
  // KECAK now carries its own price because it competes as a fifth source.
  expect(candidates.map(row => row.sourcePrice)).toEqual([70000, 80000, 9000, 8000, 9500]);
  expect(candidates.some(row => row.franchise === 'YU-GI-OH!')).toBe(false);
});

test('checker offers outside the Tokyo business date never enter the lineup', () => {
  const products = [{ source_product_id: 2, category: 'pokemon', name: 'バンク', full_name: null, model_number: '2' }];
  const candidates = tokyoProductCandidates([], products, [
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: 9000, source_updated_at: '2026-09-23T00:30:00+09:00' },
    { source_product_id: 2, shop_id: 11, condition_id: 1, edition_id: 0, buy_price: 9500, source_updated_at: '2026-09-22T23:30:00+09:00' },
    { source_product_id: 2, shop_id: 13, condition_id: 1, edition_id: 0, buy_price: 9800, source_updated_at: null },
  ], { businessDate: '2026-09-23' });
  expect(candidates.map(row => row.source)).toEqual(['toreca_bank']);
});

test('the five sources compete on discounted price and KECAK can win over Shinsoku', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: 110000 },
  ], [
    { source_product_id: 1, category: 'pokemon', name: 'カイ', full_name: null, model_number: '236/172' },
  ], [
    { source_product_id: 1, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: 100000 },
  ]);
  const result = compareTokyoSourceProducts(candidates, [OFFICIAL], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ id: 'IAP1', name: 'カイ', image_url: 'official.jpg',
    source_price: 110000, price_high: 100000, price_low: 100000,
    selected_high_source: 'kecak', selected_low_source: 'kecak' });
  expect(result.products[0].origins.map(origin => [origin.source, origin.rawPrice, origin.highPrice, origin.lowPrice])).toEqual([
    ['kecak', 110000, 100000, 100000],
    ['toreca_bank', 100000, 90000, 90000],
    ['shinsoku', 100000, 95000, 95000],
  ]);
  expect(result.priceSources).toEqual({ IAP1: { source: 'kecak', source_id: 'k1', price: 110000 } });
  expect(result.unmatched).toEqual([]);
});

test('each source applies its own high and low rate independently', () => {
  const settings = normalizeStorePricingSettings({ tokyo_source_discount_rates: {
    kecak: { high: 0.05, low: 0.20 }, shinsoku: { high: 0.10, low: 0.10 } } });
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: 100000 },
  ], [], []);
  const result = compareTokyoSourceProducts(candidates, [OFFICIAL], settings, OBSERVED_AT);
  expect(result.products[0]).toMatchObject({ price_high: 95000, selected_high_source: 'kecak',
    price_low: 90000, selected_low_source: 'shinsoku' });
});

test('a source publishes on its own and only Shinsoku supplies the catalog id', () => {
  const candidates = tokyoProductCandidates([], [
    { source_product_id: 9, category: 'one_piece', name: 'ルフィ', full_name: null, model_number: 'OP01-001', image_url: 'checker.jpg' },
  ], [
    { source_product_id: 9, shop_id: 13, condition_id: 1, edition_id: 0, buy_price: 50000 },
  ]);
  const shinsokuOnly: ShinsokuPostalProduct = { id: 'IAY1', franchise: 'YU-GI-OH!', name: '青眼の白龍',
    modelNumber: 'LB01-JP000', productType: 'PSA10', price: 80000, imageUrl: 'y.jpg' };
  const result = compareTokyoSourceProducts(candidates, [shinsokuOnly], SETTINGS, OBSERVED_AT);
  const byName = Object.fromEntries(result.products.map(product => [product.name, product]));
  expect(byName['ルフィ']).toMatchObject({ id: expect.stringMatching(/^TOKYO_[0-9a-f]{64}$/),
    price_high: 45000, price_low: 45000, selected_high_source: 'avirile', image_url: 'checker.jpg' });
  expect(byName['青眼の白龍']).toMatchObject({ id: 'IAY1', price_high: 76000, price_low: 76000,
    selected_high_source: 'shinsoku' });
});

test.each([null, 0, -1, 1.5, NaN, Infinity, 100000001])('an invalid price %s never reaches a published product', price => {
  const result = compareTokyoSourceProducts([], [{ ...OFFICIAL, price }], SETTINGS, OBSERVED_AT);
  expect(result.products).toEqual([]);
  expect(result.priceSources).toEqual({});
  expect(result.unmatched).toEqual([
    { candidate: expect.objectContaining({ source: 'shinsoku', id: 'IAP1' }), reason: 'invalid_price' },
  ]);
});

test('rows without a model number, with split source prices, or discounted to zero stay unpublished', () => {
  const noModel = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'no-model', modelNumber: '  ' }], SETTINGS, OBSERVED_AT);
  expect(noModel.products).toEqual([]);
  expect(noModel.unmatched.map(row => row.reason)).toEqual(['missing_model']);

  const split = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'a', price: 10000 },
    { ...OFFICIAL, id: 'b', price: 20000 }], SETTINGS, OBSERVED_AT);
  expect(split.products).toEqual([]);
  expect(split.unmatched.map(row => row.reason)).toEqual(['ambiguous', 'ambiguous']);

  const tiny = compareTokyoSourceProducts([], [{ ...OFFICIAL, id: 'tiny', price: 1 }], SETTINGS, OBSERVED_AT);
  expect(tiny.products).toEqual([]);
  expect(tiny.unmatched.map(row => row.reason)).toEqual(['zero_after_discount']);
});

test('the per-source discount rate applies exactly once to the raw source price', () => {
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'PSA10', 0.07)).toBe(93000);
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'BOX', 0.07)).toBe(93000);
  expect(tokyoDisplayPrice(10098, 'Pokemon', 'PSA10', 0.05)).toBe(9000);
});

test('non-Tokyo jobs reject before accessing any DB or external source', async () => {
  const store = process.env.STORE_NAME;
  try {
    for (const name of ['manman', 'oripark', 'manman-tokyo', '']) {
      process.env.STORE_NAME = name;
      await expect(runTokyoBuybackSync({ dryRun: true })).rejects.toThrow('東京満満専用');
    }
  } finally {
    if (store === undefined) delete process.env.STORE_NAME; else process.env.STORE_NAME = store;
  }
});
