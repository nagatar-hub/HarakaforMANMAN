import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShinsokuPostalProducts, postalProductIdentity } from '@haraka/shared';
import { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';
import { fetchBlueRocketPsaPrices } from '../lib/blue-rocket';
import { fetchExtorecaBoxSheet, fetchExtorecaPsaSheet } from '../lib/extoreca-sheet';
import { fetchCheckerShops } from '../lib/kaitori-checker-shops';
import { fetchBlueRocketQuantityQuotes } from '../lib/blue-rocket-quantity';

jest.mock('../lib/kaitori-checker-shops', () => ({ fetchCheckerShops: jest.fn() }));
jest.mock('../lib/blue-rocket-quantity', () => ({
  ...jest.requireActual('../lib/blue-rocket-quantity'), fetchBlueRocketQuantityQuotes: jest.fn(),
}));
jest.mock('@haraka/shared', () => ({
  ...jest.requireActual('@haraka/shared'), fetchShinsokuPostalProducts: jest.fn(),
}));
jest.mock('../lib/blue-rocket', () => ({
  ...jest.requireActual('../lib/blue-rocket'), fetchBlueRocketPsaPrices: jest.fn(),
}));
jest.mock('../lib/extoreca-sheet', () => ({
  ...jest.requireActual('../lib/extoreca-sheet'), fetchExtorecaBoxSheet: jest.fn(), fetchExtorecaPsaSheet: jest.fn(),
}));

const SHOPS = [11, 44, 51, 54, 55];
const now = new Date('2026-09-09T03:30:00Z');
const SAME_DAY = '2026-09-09T02:00:00Z';
const PREVIOUS_DAY = '2026-09-08T02:00:00Z';
const completed = { id: 'complete', store: 'oripark', status: 'applied',
  created_at: '2026-09-08T22:06:00Z', completed_at: '2026-09-08T23:40:00Z', product_count: 2, offer_count: 6 };

function checkerFixture(): Awaited<ReturnType<typeof fetchCheckerShops>> {
  return {
    products: [
      { source_product_id: 1, category: 'pokemon', name: 'カイ', model_number: '236/172', full_name: null, image_url: null },
      { source_product_id: 21461, category: 'pokemon', name: 'テラスタルフェスex', model_number: null, full_name: null, image_url: null },
    ],
    offers: [
      { source_product_id: 1, shop_id: 51, shop_name: 'Blue Rocket LAOX', condition_id: 1, edition_id: 0,
        edition_name: null, buy_price: 125000, source_updated_at: SAME_DAY },
      { source_product_id: 21461, shop_id: 11, shop_name: 'Blue Rocket 秋葉原', condition_id: 2, edition_id: 0,
        edition_name: null, buy_price: 40000, source_updated_at: SAME_DAY },
    ],
    report: { api_base: 'https://apn.kaitori-checker.com', shop_ids: SHOPS, condition_ids: [1, 2],
      fetched_at: now.toISOString(), product_count: 2, offer_count: 2,
      shops: SHOPS.map(shopId => ({ shop_id: shopId, shop_name: `Shop ${shopId}`, received_count: 1,
        offer_count: [11, 51].includes(shopId) ? 1 : 0, error: null })) },
  };
}

function database(checkerRows: object[] = [], extraSettings: object = {}) {
  const tables: Record<string, any[]> = {
    order_list_import: [{ id: 'order', store: 'manman-akihabara', business_date: '2026-09-09',
      structural_valid: true, persistence_complete: true, status: 'applied' }],
    kaitori_checker_sync_run: checkerRows,
    store_config: [{ store: 'manman-akihabara', settings: { psa10_discount_rates: { Pokemon: 0.04 }, ...extraSettings } }],
    order_list_item: [{ id: 'k', import_id: 'order', excel_product_id: 'k', franchise: 'Pokemon', card_name: 'カイ',
      list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: 130000 }],
  };
  return { from: jest.fn((table: string) => {
    let rows = [...tables[table]];
    const chain: any = {
      select: () => chain,
      eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return chain; },
      order: () => chain,
      limit: (n: number) => { rows = rows.slice(0, n); return chain; },
      range: (start: number, end: number) => { rows = rows.slice(start, end + 1); return chain; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return chain;
  }) } as unknown as SupabaseClient;
}

beforeEach(() => {
  jest.mocked(fetchCheckerShops).mockReset().mockResolvedValue(checkerFixture());
  jest.mocked(fetchBlueRocketQuantityQuotes).mockReset().mockResolvedValue({ quotes: [],
    report: { shops: [], quantity_unavailable_shop_ids: [44] } });
  jest.mocked(fetchShinsokuPostalProducts).mockReset().mockResolvedValue([
    { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 123000, imageUrl: null },
  ]);
  jest.mocked(fetchBlueRocketPsaPrices).mockReset();
  jest.mocked(fetchExtorecaBoxSheet).mockReset().mockResolvedValue([]);
  jest.mocked(fetchExtorecaPsaSheet).mockReset().mockResolvedValue([]);
});

test('fetches PSA and BOX from all five shops once without the legacy public PSA or global checker paths', async () => {
  const db = database();
  const result = await buildTokyoBuybackSnapshot(db, now);
  expect(fetchCheckerShops).toHaveBeenCalledTimes(1);
  expect(fetchCheckerShops).toHaveBeenCalledWith(SHOPS, [1, 2]);
  expect(fetchBlueRocketPsaPrices).not.toHaveBeenCalled();
  expect(jest.mocked(db.from).mock.calls.flat()).not.toContain('kaitori_checker_sync_run');
  expect(result.snapshot).toMatchObject({ checker_run_id: null, checker_source_store: 'manman-akihabara',
    business_date: '2026-09-09', report: { checker_api: { shop_ids: SHOPS, condition_ids: [1, 2] },
      source_counts: { kecak: 1, blue_rocket: 2, extoreca: 0, toreca_bank: 0, avirile: 0, shinsoku: 1 },
      blue_rocket_psa: { source: 'kaitori_checker', used: 1, skipped: [] } } });
  expect(result.products.map(product => [product.source_price, product.selected_high_source, product.product_type]))
    .toEqual([[130000, 'kecak', 'psa'], [40000, 'blue_rocket', 'box']]);
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')).toMatchObject({
    id: '1:1:0', shopId: 51, shopName: 'Blue Rocket LAOX', rawPrice: 125000,
  });
});

test.each(SHOPS)('PSA from branch %i reaches the final comparison with its actual provenance', async shopId => {
  const checker = checkerFixture();
  Object.assign(checker.offers[0], { shop_id: shopId, shop_name: `Shop ${shopId}`, buy_price: 150000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products[0]).toMatchObject({ source_price: 150000, selected_high_source: 'blue_rocket', price_high: 130000 });
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket'))
    .toMatchObject({ shopId, shopName: `Shop ${shopId}` });
});

test.each([1, 2])('condition %i keeps the highest branch price and a stable winner for ties', async conditionId => {
  const checker = checkerFixture();
  const base = checker.offers.find(offer => offer.condition_id === conditionId)!;
  checker.offers = SHOPS.slice().reverse().map(shopId => ({ ...base, shop_id: shopId, shop_name: `Shop ${shopId}`,
    buy_price: [51, 55].includes(shopId) ? 150000 : 140000 }));
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const products = result.products.filter(product => product.product_type === (conditionId === 1 ? 'psa' : 'box'));
  expect(products).toHaveLength(1);
  expect(products[0].origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId: 51, shopName: 'Shop 51', rawPrice: 150000 }]);
});

test.each([false, true])('single-card quotes are removed before branch selection; all branches limited: %s', async allSingle => {
  const checker = checkerFixture();
  checker.offers[0].buy_price = 150000;
  checker.offers.push({ ...checker.offers[0], shop_id: 11, shop_name: 'Blue Rocket 秋葉原', buy_price: 140000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const identity = postalProductIdentity({ franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10' });
  jest.mocked(fetchBlueRocketQuantityQuotes).mockResolvedValue({ quotes: [
    { shopId: 51, identity, price: 150000, singleQuantity: true, productId: 123 },
    { shopId: 11, identity, price: 140000, singleQuantity: allSingle, productId: 124 },
  ], report: { shops: [], quantity_unavailable_shop_ids: [44] } });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const psa = result.products.find(product => product.product_type === 'psa')!;
  expect(psa.source_price).toBe(allSingle ? 130000 : 140000);
  expect(psa.origins.find(origin => origin.source === 'blue_rocket')).toEqual(allSingle ? undefined
    : expect.objectContaining({ shopId: 11, rawPrice: 140000 }));
  expect(result.products.find(product => product.product_type === 'box')).toMatchObject({ source_price: 40000 });
  expect(result.snapshot.report.blue_rocket_psa.quantity.excluded_single_quantity_count).toBe(allSingle ? 2 : 1);
});

test.each(['HTTP 503', 'ブルーロケット募集数APIの営業日が許容範囲外です'])('quantity API failure %s removes only that branch PSA', async error => {
  const checker = checkerFixture();
  checker.offers[0].buy_price = 150000;
  checker.offers.push({ ...checker.offers[0], shop_id: 44, shop_name: 'Blue Rocket 郵送', buy_price: 140000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  jest.mocked(fetchBlueRocketQuantityQuotes).mockResolvedValue({ quotes: [], report: {
    shops: [{ shop_id: 51, store_code: 'laox', parsed_quote_count: 0, error }], quantity_unavailable_shop_ids: [44],
  } });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products[0]).toMatchObject({ source_price: 140000 });
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')).toMatchObject({ shopId: 44 });
  expect(result.products.find(product => product.product_type === 'box')).toMatchObject({ source_price: 40000 });
  expect(result.snapshot.report.blue_rocket_psa.quantity).toMatchObject({ failed_shop_ids: [51],
    excluded_single_quantity_count: 0, excluded_quantity_unavailable_count: 1 });
});

test('one unavailable branch is reported while another branch still publishes', async () => {
  const checker = checkerFixture();
  checker.report.shops[0].error = 'HTTP 503';
  checker.offers = checker.offers.filter(offer => offer.shop_id !== 11);
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.snapshot.report.checker_api.shops[0].error).toBe('HTTP 503');
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')?.shopId).toBe(51);
});

test.each([[], [{ ...completed, status: 'running' }], [{ ...completed, status: 'failed' }],
  [{ ...completed, completed_at: '2020-01-01T00:00:00Z' }], [{ ...completed, product_count: 999 }]].map(rows => [rows]))(
  'global checker state %j does not block a fresh shop response', async rows => {
    await expect(buildTokyoBuybackSnapshot(database(rows), now)).resolves.toMatchObject({ snapshot: { checker_run_id: null } });
  });

test.each([PREVIOUS_DAY, '2026-09-10T02:00:00Z', null])('an unusable branch date %s cannot override a current quote', async date => {
  const checker = checkerFixture();
  checker.offers.push({ ...checker.offers[0], shop_id: 55, buy_price: 999000, source_updated_at: date });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database([], { tokyo_price_max_age_days: 0 }), now);
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket'))
    .toMatchObject({ shopId: 51, rawPrice: 125000 });
});

test('the approved one-day window keeps prior prices and same-day policy excludes them', async () => {
  const nextDay = new Date('2026-09-09T20:00:00Z');
  const allowed = await buildTokyoBuybackSnapshot(database(), nextDay);
  expect(allowed.snapshot.report.source_counts).toMatchObject({ kecak: 1, blue_rocket: 2 });
  const strict = await buildTokyoBuybackSnapshot(database([], { tokyo_price_max_age_days: 0 }), nextDay);
  expect(strict.snapshot.report.source_counts).toMatchObject({ kecak: 0, blue_rocket: 0 });
  expect(strict.products).toMatchObject([{ id: 'IAP1', source_price: 123000, selected_high_source: 'shinsoku' }]);
});

test('a different language sharing the model number does not inherit the base card identity', async () => {
  const checker = checkerFixture();
  checker.products[0].aspect = '中国語版';
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products[0].origins.map(origin => origin.source)).toEqual(['kecak', 'shinsoku']);
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({ used: 0, skipped: [{ name: 'カイ(中国語版)' }] });
});

test('an Extoreca tab failure is explicit while the other tab joins the comparison', async () => {
  jest.mocked(fetchExtorecaBoxSheet).mockRejectedValue(new Error('エクストレカBOX表の取得失敗: HTTP 503'));
  jest.mocked(fetchExtorecaPsaSheet).mockResolvedValue([
    { id: 'sheet:psa10:2', name: 'カイ', modelNumber: '236/172', price: 140000, productType: 'PSA10' },
  ]);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products[0]).toMatchObject({ source_price: 140000, selected_high_source: 'extoreca', price_high: 120000 });
  expect(result.snapshot.report.extoreca).toMatchObject({ box: { error: expect.stringContaining('HTTP 503') }, psa: { used: 1 } });
});

test('invalid price-age configuration fails before any API fetch', async () => {
  await expect(buildTokyoBuybackSnapshot(database([], { tokyo_price_max_age_days: 31 }), now)).rejects.toThrow();
  expect(fetchCheckerShops).not.toHaveBeenCalled();
});

test('all-shop failure cannot fall back to stale global data', async () => {
  jest.mocked(fetchCheckerShops).mockRejectedValue(new Error('買取チェッカーの参照店舗を取得できません'));
  await expect(buildTokyoBuybackSnapshot(database([completed]), now)).rejects.toThrow('参照店舗を取得できません');
});
