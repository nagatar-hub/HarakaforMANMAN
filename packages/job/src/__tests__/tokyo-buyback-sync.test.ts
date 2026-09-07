import { normalizeStorePricingSettings } from '@haraka/shared';
import { runTokyoBuybackSync, tokyoDisplayPrice, tokyoProductCandidates } from '../jobs/tokyo-buyback-sync';

test('union includes KECAK-only, bank-only and avirile-only products without using their prices', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'unmatched' },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '素体', list_no: '1', grade: 'S', match_status: 'matched' },
  ], [
    { source_product_id: 2, category: 'pokemon', name: 'バンクのみ', full_name: null, model_number: '2' },
    { source_product_id: 3, category: 'one_piece', name: 'アヴィリールのみ', full_name: null, model_number: null },
  ], [
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0 },
    { source_product_id: 3, shop_id: 13, condition_id: 2, edition_id: 0 },
    { source_product_id: 2, shop_id: 22, condition_id: 1, edition_id: 0 },
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0 },
  ]);
  expect(candidates.map(row => row.source)).toEqual(['kecak', 'toreca_bank', 'avirile']);
  expect(candidates.map(row => row.productType)).toEqual(['PSA10', 'PSA10', 'BOX']);
});

test('Tokyo settings apply exactly once to the raw postal price', () => {
  const settings = normalizeStorePricingSettings({ psa10_discount_rates: { Pokemon: 0.07 }, box_discount_rates: { Pokemon: { shrink: 0.07 } } });
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'PSA10', settings)).toBe(93000);
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'BOX', settings)).toBe(93000);
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
