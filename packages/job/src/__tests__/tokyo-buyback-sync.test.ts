import { normalizeStorePricingSettings } from '@haraka/shared';
import { runTokyoBuybackSync, tokyoDisplayPrice, tokyoProductCandidates, tokyoMatchPostalProducts } from '../jobs/tokyo-buyback-sync';
import type { ShinsokuPostalProduct } from '@haraka/shared';

test('lineup union includes only KECAK, Bank and Avirile candidates', () => {
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: 'カイ', list_no: '236/172', grade: 'PSA10', match_status: 'unmatched', source_price: 70000 },
    { id: 'k2', excel_product_id: 'k2', franchise: 'Pokemon', card_name: '素体', list_no: '1', grade: 'S', match_status: 'matched', source_price: 1 },
    { id: 'k3', excel_product_id: 'k3', franchise: 'WEISS SCHWARZ', card_name: '旧KECAKヴァイス', list_no: '1', grade: 'PSA10', match_status: 'matched', source_price: 80000 },
  ], [
    { source_product_id: 2, category: 'pokemon', name: 'バンクのみ', full_name: null, model_number: '2' },
    { source_product_id: 3, category: 'one_piece', name: 'アヴィリールのみ', full_name: null, model_number: null },
  ], [
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: 9000 },
    { source_product_id: 3, shop_id: 13, condition_id: 2, edition_id: 0, buy_price: 8000 },
    { source_product_id: 2, shop_id: 22, condition_id: 1, edition_id: 0 },
    { source_product_id: 2, shop_id: 3, condition_id: 1, edition_id: 0 },
  ]);
  expect(candidates.map(row => row.source)).toEqual(['kecak', 'kecak', 'toreca_bank', 'avirile']);
  expect(candidates.map(row => row.productType)).toEqual(['PSA10', 'PSA10', 'PSA10', 'BOX']);
  expect(candidates[0]).toMatchObject({ source: 'kecak' });
  expect(candidates[0].sourcePrice).toBeUndefined();
  expect(candidates.slice(2).map(row => row.sourcePrice)).toEqual([9000, 8000]);
});

test('Shinsoku confirms candidate rows but never adds a Shinsoku-only lineup row', () => {
  const product = (id: string, franchise: string, price: number | null = 10000): ShinsokuPostalProduct =>
    ({ id, franchise, name: '同名', modelNumber: null, productType: 'PSA10', price, imageUrl: null });
  const candidates = tokyoProductCandidates([
    { id: 'k1', excel_product_id: 'k1', franchise: 'Pokemon', card_name: '同名', list_no: '001/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
    { id: 'kw', excel_product_id: 'kw', franchise: 'WEISS SCHWARZ', card_name: '同名', list_no: 'W/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
    { id: 'kd', excel_product_id: 'kd', franchise: 'DRAGON BALL', card_name: '同名', list_no: 'D/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
    { id: 'kb', excel_product_id: 'kb', franchise: 'DRAGON BALL', card_name: '[1BOX]同名', list_no: null, grade: 'BOX', match_status: 'matched', source_price: 9000 },
    { id: 'ky', excel_product_id: 'ky', franchise: 'YU-GI-OH!', card_name: 'KECAK遊戯除外', list_no: 'Y/001', grade: 'PSA10', match_status: 'matched', source_price: 9000 },
  ], [], []);
  const listedPokemon = { ...product('p1', 'Pokemon'), modelNumber: '001/001' };
  const rows = [listedPokemon, product('p-unlisted', 'Pokemon'), product('op-unlisted', 'ONE PIECE'),
    product('y1', 'YU-GI-OH!'), product('y2', 'YU-GI-OH!'), product('y1', 'YU-GI-OH!'),
    { ...product('w1', 'WEISS SCHWARZ'), modelNumber: 'W/001' }, product('w-unlisted', 'WEISS SCHWARZ'),
    { ...product('w-box-unlisted', 'WEISS SCHWARZ'), productType: 'BOX' as const },
    { ...product('d-psa', 'DRAGON BALL'), modelNumber: 'D/001' }, product('d-psa-unlisted', 'DRAGON BALL'),
    { ...product('d1', 'DRAGON BALL'), productType: 'BOX' as const },
    product('zero', 'YU-GI-OH!', 0), product('null', 'YU-GI-OH!', null)];
  const result = tokyoMatchPostalProducts(candidates, rows);
  expect(result.matched.map(row => row.product.id)).toEqual(['p1', 'w1', 'd-psa', 'd1']);
  expect(result.matched.find(row => row.product.id === 'd1')?.sources.map(row => row.source)).toEqual(['kecak', 'shinsoku']);
  expect(result.matched.find(row => row.product.id === 'w1')?.sources.map(row => row.source)).toEqual(['kecak', 'shinsoku']);
  expect(result.matched.find(row => row.product.id === 'd-psa')?.sources.map(row => row.source)).toEqual(['kecak', 'shinsoku']);
  expect(candidates.some(row => row.franchise === 'YU-GI-OH!')).toBe(false);
  expect(result.matched[0].sources[0].source).toBe('kecak');
  expect(result.priceSources).toEqual({
    p1: { source: 'shinsoku', source_id: 'p1', price: 10000 },
    w1: { source: 'shinsoku', source_id: 'w1', price: 10000 },
    'd-psa': { source: 'shinsoku', source_id: 'd-psa', price: 10000 },
    d1: { source: 'shinsoku', source_id: 'd1', price: 10000 },
  });
  expect(result.unmatched).toEqual([]);
});

test('checker lineup requires a current Shinsoku postal catalog match', () => {
  const products = [{ source_product_id: 21461, category: 'pokemon', name: 'エーフィ☆', full_name: 'エーフィ☆ 025/PLAY',
    model_number: '025/PLAY', image_url: 'checker.jpg' }];
  const offers = [
    { source_product_id: 21461, shop_id: 13, condition_id: 1, edition_id: 0, buy_price: 37000000 },
    { source_product_id: 21461, shop_id: 22, condition_id: 1, edition_id: 0, buy_price: 15000000 },
  ];
  const candidates = tokyoProductCandidates([], products, offers);
  expect(tokyoMatchPostalProducts(candidates, []).matched).toEqual([]);
  expect(tokyoMatchPostalProducts(candidates, []).unmatched).toEqual([
    { candidate: expect.objectContaining({ source: 'avirile', name: 'エーフィ☆', modelNumber: '025/PLAY' }), reason: 'not_found' },
  ]);
  const matched = tokyoMatchPostalProducts(candidates, [{ id: 'live', franchise: 'Pokemon', name: 'エーフィ☆', modelNumber: '025/PLAY',
    productType: 'PSA10', price: 123000, imageUrl: 'live.jpg' }]);
  expect(matched.matched[0].product.price).toBe(123000);
  expect(matched.priceSources.live).toEqual({ source: 'shinsoku', source_id: 'live', price: 123000 });
});

test('Tokyo settings apply exactly once to the raw postal price', () => {
  const settings = normalizeStorePricingSettings({ psa10_discount_rates: { Pokemon: 0.07 }, box_discount_rates: { Pokemon: { shrink: 0.07 } } });
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'PSA10', settings)).toBe(93000);
  expect(tokyoDisplayPrice(100000, 'Pokemon', 'BOX', settings)).toBe(93000);
  expect(tokyoDisplayPrice(10098, 'Pokemon', 'PSA10', normalizeStorePricingSettings({ psa10_discount_rates: { Pokemon: 0.05 } }))).toBe(9000);
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
