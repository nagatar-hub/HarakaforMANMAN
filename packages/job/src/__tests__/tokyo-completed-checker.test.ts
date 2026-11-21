import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShinsokuPostalProducts, postalProductIdentity } from '@haraka/shared';
import { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';
import { fetchBlueRocketPsaPrices } from '../lib/blue-rocket';
import { fetchExtorecaBoxSheet, fetchExtorecaPsaSheet } from '../lib/extoreca-sheet';
import { fetchCheckerShops } from '../lib/kaitori-checker-shops';
import { fetchBlueRocketQuantityQuotes } from '../lib/blue-rocket-quantity';
import { fetchWithRetry } from '../lib/fetch-with-retry';

jest.mock('../lib/kaitori-checker-shops', () => ({ fetchCheckerShops: jest.fn() }));
jest.mock('../lib/fetch-with-retry', () => ({ fetchWithRetry: jest.fn() }));
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

const SHOPS = [11, 73];
const OTHER_SHOPS = [44, 51, 54, 55];
const SHOP_NAME = 'Blue Rocket（ブルロケ）秋葉原昭和通り店';
const SUEHIROCHO_NAME = 'Blue Rocket（ブルロケ）秋葉原末広町店';
const SHOP_NAMES: Record<number, string> = { 11: SHOP_NAME, 73: SUEHIROCHO_NAME };
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
    offers: SHOPS.flatMap(shopId => [
      { source_product_id: 1, shop_id: shopId, shop_name: SHOP_NAMES[shopId], condition_id: 1, edition_id: 0,
        edition_name: null, buy_price: shopId === 11 ? 125000 : 120000, source_updated_at: SAME_DAY },
      { source_product_id: 21461, shop_id: shopId, shop_name: SHOP_NAMES[shopId], condition_id: 2, edition_id: 0,
        edition_name: null, buy_price: shopId === 11 ? 40000 : 38000, source_updated_at: SAME_DAY },
    ]),
    report: { api_base: 'https://apn.kaitori-checker.com', shop_ids: SHOPS, condition_ids: [1, 2],
      fetched_at: now.toISOString(), product_count: 2, offer_count: 4,
      shops: SHOPS.map(shopId => ({ shop_id: shopId, shop_name: `Shop ${shopId}`, received_count: 1,
        offer_count: 2, error: null })) },
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
    report: { shops: [], quantity_unavailable_shop_ids: [] } });
  jest.mocked(fetchWithRetry).mockReset();
  jest.mocked(fetchShinsokuPostalProducts).mockReset().mockResolvedValue([
    { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 123000, imageUrl: null },
  ]);
  jest.mocked(fetchBlueRocketPsaPrices).mockReset();
  jest.mocked(fetchExtorecaBoxSheet).mockReset().mockResolvedValue([]);
  jest.mocked(fetchExtorecaPsaSheet).mockReset().mockResolvedValue([]);
});

test('fetches PSA and BOX from checker shops 11 and 73 without legacy public PSA or global checker paths', async () => {
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
    id: '1:1:0', shopId: 11, shopName: SHOP_NAME, rawPrice: 125000,
  });
});

test('the snapshot path requests checker shops 11/73 and exactly the two official quantity APIs', async () => {
  jest.mocked(fetchBlueRocketQuantityQuotes).mockImplementation(jest.requireActual('../lib/blue-rocket-quantity').fetchBlueRocketQuantityQuotes);
  jest.mocked(fetchWithRetry).mockImplementation(async url => {
    const store = new URL(url).searchParams.get('store');
    return new Response(JSON.stringify({ storeId: store, storeCode: store, businessDate: '2026-09-09', items: [] }));
  });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(fetchCheckerShops).toHaveBeenCalledWith([11, 73], [1, 2]);
  expect(fetchWithRetry).toHaveBeenCalledTimes(2);
  expect(jest.mocked(fetchWithRetry).mock.calls.map(([url]) => url).sort()).toEqual([
    'https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=akihabara',
    'https://bluerocket-kaitori.xvps.jp/lottery/api/prices?store=suehirocho',
  ]);
  expect(result.snapshot.report.blue_rocket_psa.quantity).toMatchObject({
    shops: [{ shop_id: 11, store_code: 'akihabara', error: null }, { shop_id: 73, store_code: 'suehirocho', error: null }],
    quantity_unavailable_shop_ids: [],
  });
});

test.each(SHOPS.flatMap(shopId => [1, 2].map(conditionId => [shopId, conditionId])))('branch %i condition %i reaches comparison with actual provenance', async (shopId, conditionId) => {
  const checker = checkerFixture();
  Object.assign(checker.offers.find(offer => offer.shop_id === shopId && offer.condition_id === conditionId)!, { buy_price: 150000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const product = result.products.find(row => row.product_type === (conditionId === 1 ? 'psa' : 'box'))!;
  expect(product).toMatchObject({ source_price: 150000, selected_high_source: 'blue_rocket' });
  expect(product.origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId, shopName: SHOP_NAMES[shopId] }]);
});

test.each([1, 2])('condition %i ignores unreferenced high prices and resolves an equal 11/73 price to 11', async conditionId => {
  const checker = checkerFixture();
  const base = checker.offers.find(offer => offer.condition_id === conditionId)!;
  checker.offers = [...SHOPS, ...OTHER_SHOPS].reverse().map(shopId => ({ ...base, shop_id: shopId, shop_name: `Shop ${shopId}`,
    buy_price: SHOPS.includes(shopId) ? 140000 : 150000 }));
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const products = result.products.filter(product => product.product_type === (conditionId === 1 ? 'psa' : 'box'));
  expect(products).toHaveLength(1);
  expect(products[0].origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId: 11, shopName: SHOP_NAME, rawPrice: 140000 }]);
});

test('a Suehirocho-only product joins the lineup with exact checker origin and branch name', async () => {
  const checker = checkerFixture();
  checker.products.push({ source_product_id: 999, category: 'pokemon', name: 'ピカチュウ',
    model_number: '001/999', full_name: null, image_url: null });
  checker.offers.push({ source_product_id: 999, shop_id: 73, shop_name: SUEHIROCHO_NAME,
    condition_id: 1, edition_id: 0, edition_name: null, buy_price: 50000, source_updated_at: SAME_DAY });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const products = result.products.filter(product => product.model_number === '001/999');
  expect(products).toHaveLength(1);
  expect(products[0]).toMatchObject({ source_price: 50000, selected_high_source: 'blue_rocket', product_type: 'psa' });
  expect(products[0].origins).toMatchObject([{ id: '999:1:0', shopId: 73, shopName: SUEHIROCHO_NAME, rawPrice: 50000 }]);
});

test('a single-card Suehirocho PSA quote is excluded while its highest BOX quote remains eligible', async () => {
  const checker = checkerFixture();
  checker.offers.find(offer => offer.shop_id === 11 && offer.condition_id === 1)!.buy_price = 150000;
  checker.offers.find(offer => offer.shop_id === 73 && offer.condition_id === 1)!.buy_price = 160000;
  checker.offers.find(offer => offer.shop_id === 73 && offer.condition_id === 2)!.buy_price = 50000;
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const identity = postalProductIdentity({ franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10' });
  jest.mocked(fetchBlueRocketQuantityQuotes).mockResolvedValue({ quotes: [
    { shopId: 73, identity, price: 160000, singleQuantity: true, productId: 125 },
  ], report: { shops: [], quantity_unavailable_shop_ids: [] } });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products.find(product => product.product_type === 'psa')!.origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId: 11, shopName: SHOP_NAME, rawPrice: 150000 }]);
  expect(result.products.find(product => product.product_type === 'box')!.origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId: 73, shopName: SUEHIROCHO_NAME, rawPrice: 50000 }]);
});

test.each([false, true])('one-card Showa-dori quote falls back to Suehirocho unless all referenced quotes are single: %s', async allSingle => {
  const checker = checkerFixture();
  checker.offers[0].buy_price = 150000;
  checker.offers.find(offer => offer.shop_id === 73 && offer.condition_id === 1)!.buy_price = 140000;
  checker.offers.push({ ...checker.offers[0], shop_id: 51, shop_name: 'Blue Rocket LAOX', buy_price: 160000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const identity = postalProductIdentity({ franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10' });
  jest.mocked(fetchBlueRocketQuantityQuotes).mockResolvedValue({ quotes: [
    { shopId: 11, identity, price: 150000, singleQuantity: true, productId: 124 },
    { shopId: 73, identity, price: 140000, singleQuantity: allSingle, productId: 125 },
  ], report: { shops: [], quantity_unavailable_shop_ids: [] } });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  const psa = result.products.find(product => product.product_type === 'psa')!;
  expect(psa.source_price).toBe(allSingle ? 130000 : 140000);
  expect(psa.origins.find(origin => origin.source === 'blue_rocket')).toEqual(allSingle ? undefined
    : expect.objectContaining({ shopId: 73, shopName: SUEHIROCHO_NAME, rawPrice: 140000 }));
  expect(result.products.find(product => product.product_type === 'box')).toMatchObject({ source_price: 40000 });
  expect(result.snapshot.report.blue_rocket_psa.quantity.excluded_single_quantity_count).toBe(allSingle ? 2 : 1);
});

test.each(['HTTP 503', 'ブルーロケット募集数APIの営業日が許容範囲外です'])('quantity API failure %s removes only that branch PSA', async error => {
  const checker = checkerFixture();
  checker.offers[0].buy_price = 150000;
  checker.offers.find(offer => offer.shop_id === 73 && offer.condition_id === 1)!.buy_price = 140000;
  checker.offers.push({ ...checker.offers[0], shop_id: 44, shop_name: 'Blue Rocket 郵送', buy_price: 140000 });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  jest.mocked(fetchBlueRocketQuantityQuotes).mockResolvedValue({ quotes: [], report: {
    shops: [{ shop_id: 11, store_code: 'akihabara', parsed_quote_count: 0, error }], quantity_unavailable_shop_ids: [],
  } });
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.products[0]).toMatchObject({ source_price: 140000 });
  expect(result.products[0].origins.filter(origin => origin.source === 'blue_rocket'))
    .toMatchObject([{ shopId: 73, shopName: SUEHIROCHO_NAME }]);
  expect(result.products.find(product => product.product_type === 'box')).toMatchObject({ source_price: 40000 });
  expect(result.snapshot.report.blue_rocket_psa.quantity).toMatchObject({ failed_shop_ids: [11],
    excluded_single_quantity_count: 0, excluded_quantity_unavailable_count: 1 });
});

test('an empty Showa-dori response leaves Suehirocho PSA and BOX available', async () => {
  const checker = checkerFixture();
  checker.report.shops[0].offer_count = 0;
  checker.offers = checker.offers.filter(offer => offer.shop_id === 73);
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database(), now);
  expect(result.snapshot.report.checker_api.shops[0].error).toBeNull();
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')).toMatchObject({ shopId: 73, shopName: SUEHIROCHO_NAME });
  expect(result.products.find(product => product.product_type === 'box')).toMatchObject({ source_price: 38000 });
});

test.each([[], [{ ...completed, status: 'running' }], [{ ...completed, status: 'failed' }],
  [{ ...completed, completed_at: '2020-01-01T00:00:00Z' }], [{ ...completed, product_count: 999 }]].map(rows => [rows]))(
  'global checker state %j does not block a fresh shop response', async rows => {
    await expect(buildTokyoBuybackSnapshot(database(rows), now)).resolves.toMatchObject({ snapshot: { checker_run_id: null } });
  });

test.each([PREVIOUS_DAY, '2026-09-10T02:00:00Z', null])('an unusable branch date %s cannot override a current quote', async date => {
  const checker = checkerFixture();
  checker.offers.push({ ...checker.offers[0], buy_price: 999000, source_updated_at: date });
  jest.mocked(fetchCheckerShops).mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database([], { tokyo_price_max_age_days: 0 }), now);
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket'))
    .toMatchObject({ shopId: 11, rawPrice: 125000 });
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
