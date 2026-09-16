import { tokyoMatchPostalProducts, tokyoProductCandidates } from '../jobs/tokyo-buyback-sync';
import type { ShinsokuPostalProduct } from '@haraka/shared';

const official: ShinsokuPostalProduct = { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 10000, imageUrl: 'official.jpg' };
const kecak = (price: number | null, id = 'k1', demand = 0) => tokyoProductCandidates([
  { id, excel_product_id: id, franchise: 'Pokemon', card_name: 'カイ(SA)', list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: price, demand, db_card_id: 'card1' },
], [], [])[0];
const shop = (source: 'toreca_bank' | 'avirile', price: number | null, id = source) =>
  ({ ...kecak(null), source, id, sourcePrice: price });

test('candidate prices are ignored and the matched Shinsoku postal price is selected', () => {
  const result = tokyoMatchPostalProducts([kecak(1), shop('toreca_bank', 9000), shop('avirile', 8000)], [official]);
  expect(result.matched[0].product).toEqual(official);
  expect(result.priceSources.IAP1).toEqual({ source: 'shinsoku', source_id: 'IAP1', price: 10000 });
  expect(result.matched[0].sources[0]).toMatchObject({ source: 'kecak', dbCardId: 'card1' });
});

test.each([0, 3])('KECAK-only product is omitted at demand %i even when KECAK has a price', demand => {
  expect(tokyoMatchPostalProducts([kecak(9000, 'k1', demand)], []).matched).toEqual([]);
  expect(tokyoMatchPostalProducts([kecak(9000, 'k1', demand)], [{ ...official, price: null }]).matched).toEqual([]);
});

test('Bank or Avirile prices never publish a row without a Shinsoku match', () => {
  const result = tokyoMatchPostalProducts([kecak(1), shop('toreca_bank', 9000), shop('avirile', 8000)], []);
  expect(result.matched).toEqual([]);
  expect(result.priceSources).toEqual({});
  expect(result.unmatched.map(row => row.reason)).toEqual(['not_found', 'not_found', 'not_found']);
});

test.each([null, 0, -1, 1.5, NaN, Infinity, 100000001])('invalid Shinsoku price %s is never published', price => {
  const result = tokyoMatchPostalProducts([kecak(9000), shop('toreca_bank', 9000)], [{ ...official, price }]);
  expect(result.matched).toEqual([]);
  expect(result.unmatched.every(row => row.reason === 'missing_price')).toBe(true);
});
