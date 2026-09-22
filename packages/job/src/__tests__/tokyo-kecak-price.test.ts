import { normalizeStorePricingSettings } from '@haraka/shared';
import { compareTokyoSourceProducts, tokyoProductCandidates, type TokyoCandidate } from '../jobs/tokyo-buyback-sync';
import type { ShinsokuPostalProduct } from '@haraka/shared';

const SETTINGS = normalizeStorePricingSettings({});
const OBSERVED_AT = '2026-09-09T05:00:00.000Z';
const official: ShinsokuPostalProduct = { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 10000, imageUrl: 'official.jpg' };
const kecak = (price: number | null, id = 'k1', demand = 0): TokyoCandidate => tokyoProductCandidates([
  { id, excel_product_id: id, franchise: 'Pokemon', card_name: 'カイ(SA)', list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: price, demand, db_card_id: 'card1' },
], [], [])[0];
const shop = (source: 'toreca_bank' | 'avirile' | 'blue_rocket', price: number | null, id = source): TokyoCandidate =>
  ({ ...kecak(null), source, id, sourcePrice: price });

test('the highest discounted price wins and the losing sources stay on the record', () => {
  const result = compareTokyoSourceProducts(
    [kecak(9000), shop('toreca_bank', 11000), shop('avirile', 8000)], [official], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  // 11,000 @10% = 9,000 beats KECAK 9,000 @5% = 8,000, Avirile 8,000 @10% = 7,000
  // and ties Shinsoku 10,000 @5% = 9,000, which the source order resolves to the earlier source.
  expect(result.products[0]).toMatchObject({ id: 'IAP1', source_price: 11000, price_high: 9000,
    selected_high_source: 'toreca_bank', selected_low_source: 'toreca_bank' });
  expect(result.products[0].origins.map(origin => [origin.source, origin.highPrice])).toEqual([
    ['kecak', 8000], ['toreca_bank', 9000], ['avirile', 7000], ['shinsoku', 9000],
  ]);
  expect(result.priceSources.IAP1).toEqual({ source: 'toreca_bank', source_id: 'toreca_bank', price: 11000 });
});

test('KECAK supplies both a price and its DB card id as a first-class source', () => {
  const result = compareTokyoSourceProducts([kecak(20000)], [official], SETTINGS, OBSERVED_AT);
  expect(result.products[0]).toMatchObject({ id: 'IAP1', source_price: 20000, price_high: 19000,
    selected_high_source: 'kecak', selected_low_source: 'kecak' });
  expect(result.products[0].origins[0]).toMatchObject({ source: 'kecak', dbCardId: 'card1', rawPrice: 20000 });
});

test.each([0, 3])('KECAK publishes without Shinsoku at demand %i, under its own hashed id', demand => {
  const result = compareTokyoSourceProducts([kecak(9000, 'k1', demand)], [], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ id: expect.stringMatching(/^TOKYO_[0-9a-f]{64}$/),
    source_price: 9000, price_high: 8000, selected_high_source: 'kecak' });
  // An unusable Shinsoku row neither publishes nor suppresses the KECAK price.
  const withDeadShinsoku = compareTokyoSourceProducts([kecak(9000, 'k1', demand)], [{ ...official, price: null }], SETTINGS, OBSERVED_AT);
  expect(withDeadShinsoku.products.map(product => product.selected_high_source)).toEqual(['kecak']);
  expect(withDeadShinsoku.unmatched.map(row => row.reason)).toEqual(['invalid_price']);
});

test('Bank, Avirile and Blue Rocket prices publish without a Shinsoku match', () => {
  const result = compareTokyoSourceProducts(
    [kecak(1), shop('toreca_bank', 9000), shop('avirile', 8000), shop('blue_rocket', 30000)],
    [], SETTINGS, OBSERVED_AT);
  expect(result.products).toHaveLength(1);
  expect(result.products[0]).toMatchObject({ source_price: 30000, price_high: 27000,
    selected_high_source: 'blue_rocket', selected_low_source: 'blue_rocket' });
  expect(result.unmatched).toEqual([]);
});

test.each([null, 0, -1, 1.5, NaN, Infinity, 100000001])('invalid Shinsoku price %s is never published', price => {
  const result = compareTokyoSourceProducts([], [{ ...official, price }], SETTINGS, OBSERVED_AT);
  expect(result.products).toEqual([]);
  expect(result.unmatched.every(row => row.reason === 'invalid_price')).toBe(true);
});

test.each([null, 0, -1, 1.5, NaN, Infinity, 100000001])('invalid candidate price %s never reaches a published product', price => {
  const result = compareTokyoSourceProducts([shop('toreca_bank', price as number | null)], [], SETTINGS, OBSERVED_AT);
  expect(result.products).toEqual([]);
  expect(result.unmatched.every(row => row.reason === 'invalid_price')).toBe(true);
});
