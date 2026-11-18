import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShinsokuPostalProducts } from '@haraka/shared';
import { buildTokyoBuybackSnapshot, tokyoProductCandidates } from '../jobs/tokyo-buyback-sync';
import { BLUE_ROCKET_AKIHABARA_PRICES_API_URL, BLUE_ROCKET_PRICES_API_URL,
  fetchBlueRocketPsaPrices, parseBlueRocketPsaPrices, type BlueRocketPsaPrices } from '../lib/blue-rocket';
import { fetchExtorecaBoxSheet, fetchExtorecaPsaSheet } from '../lib/extoreca-sheet';
import { fetchCheckerShops } from '../lib/kaitori-checker-shops';

jest.mock('../lib/kaitori-checker-shops', () => ({ fetchCheckerShops: jest.fn() }));

jest.mock('@haraka/shared', () => ({
  ...jest.requireActual('@haraka/shared'), fetchShinsokuPostalProducts: jest.fn(),
}));
jest.mock('../lib/blue-rocket', () => ({
  ...jest.requireActual('../lib/blue-rocket'), fetchBlueRocketPsaPrices: jest.fn(),
}));
jest.mock('../lib/extoreca-sheet', () => ({
  ...jest.requireActual('../lib/extoreca-sheet'),
  fetchExtorecaBoxSheet: jest.fn(), fetchExtorecaPsaSheet: jest.fn(),
}));

const now = new Date('2026-09-09T03:30:00Z');
const completed = { id: 'complete', store: 'oripark', status: 'applied',
  created_at: '2026-09-08T22:06:00Z', completed_at: '2026-09-08T23:40:00Z', product_count: 2, offer_count: 6 };
const SAME_DAY = '2026-09-09T02:00:00Z';
const PREVIOUS_DAY = '2026-09-08T02:00:00Z';
const LAOX: BlueRocketPsaPrices = {
  storeId: 'laox', businessDate: '2026-09-09', fetchedAt: SAME_DAY, itemCount: 1,
  rows: [{ id: 'api:laox:2', name: 'カイ', modelNumber: '236/172', price: 125000, imageUrl: null }],
};
const AKIHABARA_EMPTY: BlueRocketPsaPrices = {
  storeId: 'akihabara', businessDate: '2026-09-09', fetchedAt: SAME_DAY, itemCount: 0, rows: [],
};
const mockBlueRocketStores = (laox: BlueRocketPsaPrices, akihabara = AKIHABARA_EMPTY) =>
  jest.mocked(fetchBlueRocketPsaPrices).mockImplementation(async store => store === 'akihabara' ? akihabara : laox);

// shop 3 = トレカバンク / 11 = Blue Rocket / 13 = アヴィリール / 22 = 対象外。condition 1 = PSA10 / 2 = BOX
// 東京満満は買取チェッカーからブルーロケットの BOX だけを使う（PSA10 はブルーロケット公開API）。
const OFFERS = [
  { source_product_id: 1, shop_id: 3, condition_id: 1, buy_price: 120000, source_updated_at: SAME_DAY },
  { source_product_id: 1, shop_id: 11, condition_id: 1, buy_price: 999000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 11, condition_id: 2, buy_price: 40000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 13, condition_id: 2, buy_price: 50000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 22, condition_id: 2, buy_price: 15000000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 3, condition_id: 2, buy_price: 90000000, source_updated_at: PREVIOUS_DAY },
];

function database(checkerRows: object[], offers = OFFERS, extraSettings: object = {}) {
  const tables: Record<string, any[]> = {
    order_list_import: [{ id: 'order', store: 'manman-akihabara', business_date: '2026-09-09',
      structural_valid: true, persistence_complete: true, status: 'applied' }],
    kaitori_checker_sync_run: checkerRows,
    store_config: [{ store: 'manman-akihabara',
      settings: { psa10_discount_rates: { Pokemon: 0.04 }, ...extraSettings } }],
    order_list_item: [{ id: 'k', import_id: 'order', excel_product_id: 'k', franchise: 'Pokemon', card_name: 'カイ',
      list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: 130000 }],
    kaitori_checker_product_snapshot: [
      { source_product_id: 1, category: 'pokemon', name: 'カイ', model_number: '236/172' },
      { source_product_id: 21461, category: 'pokemon', name: 'テラスタルフェスex', model_number: null },
    ].map(row => ({ ...row, run_id: 'complete', store: 'oripark' })),
    kaitori_checker_offer_snapshot: offers.map(row => ({ ...row, run_id: 'complete', store: 'oripark', edition_id: 0 })),
  };
  return { from: jest.fn((table: string) => {
    let rows = [...tables[table]];
    const chain: any = {
      select: () => chain,
      eq: (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return chain; },
      order: (key: string, options?: { ascending: boolean }) => {
        rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (options?.ascending === false ? -1 : 1));
        return chain;
      },
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
  jest.mocked(fetchCheckerShops).mockReset().mockResolvedValue({
    products: [{ source_product_id: 21461, category: 'pokemon', name: 'テラスタルフェスex',
      model_number: null, full_name: null, image_url: null }],
    offers: [{ source_product_id: 21461, shop_id: 11, shop_name: 'Blue Rocket 秋葉原', condition_id: 2, edition_id: 0,
      edition_name: null, buy_price: 40000, source_updated_at: SAME_DAY }],
    report: { api_base: 'https://apn.kaitori-checker.com', shop_ids: [11, 44, 51, 54, 55], condition_ids: [2],
      fetched_at: now.toISOString(), product_count: 1, offer_count: 1,
      shops: [{ shop_id: 11, shop_name: 'Blue Rocket 秋葉原', received_count: 1, offer_count: 1, error: null }] },
  });
  jest.mocked(fetchShinsokuPostalProducts).mockReset().mockResolvedValue([
    { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 123000, imageUrl: null },
  ]);
  jest.mocked(fetchBlueRocketPsaPrices).mockReset();
  mockBlueRocketStores(LAOX);
  jest.mocked(fetchExtorecaBoxSheet).mockReset().mockResolvedValue([]);
  jest.mocked(fetchExtorecaPsaSheet).mockReset().mockResolvedValue([]);
});

test.each(['running', 'cancelled', 'failed'])('Tokyo fetches only its referenced shop while the global checker is %s', async status => {
  const db = database([completed, { ...completed, id: 'newest', status, created_at: '2026-09-09T02:59:00Z', completed_at: null }]);
  const result = await buildTokyoBuybackSnapshot(db, now);
  expect(result.snapshot.checker_run_id).toBeNull();
  expect(result.snapshot.checker_source_store).toBe('manman-akihabara');
  expect(fetchCheckerShops).toHaveBeenCalledWith([11, 44, 51, 54, 55], [2]);
  expect(result.snapshot.report.checker_api).toMatchObject({ shop_ids: [11, 44, 51, 54, 55], condition_ids: [2] });
  expect(jest.mocked(db.from).mock.calls.map(([table]) => table)).not.toEqual(
    expect.arrayContaining(['kaitori_checker_sync_run']));
  expect(result.snapshot.business_date).toBe('2026-09-09');
  // ブルーロケットはAPIの PSA10 1件 + 買取チェッカーの BOX 1件。トレカバンク・アヴィリールは使わない。
  expect(result.snapshot.report.source_counts).toEqual({
    kecak: 1, blue_rocket: 2, extoreca: 0, toreca_bank: 0, avirile: 0, shinsoku: 1 });
  // 元価格が一番高い KECAK 130,000 を採用。買取チェッカー経由のブルロケ PSA 999,000 は使わない。
  expect(result.products.map(product => [product.id, product.source_price, product.selected_high_source, product.product_type])).toEqual([
    ['IAP1', 130000, 'kecak', 'psa'],
    [expect.stringMatching(/^TOKYO_[0-9a-f]{64}$/), 40000, 'blue_rocket', 'box'],
  ]);
  expect(result.products[0].price_high).toBe(120000);
  expect(result.products[0].origins.map(origin => [origin.source, origin.rawPrice])).toEqual([
    ['kecak', 130000], ['blue_rocket', 125000], ['shinsoku', 123000]]);
  expect(result.products[1].origins.map(origin => origin.source)).toEqual(['blue_rocket']);
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({
    url: BLUE_ROCKET_PRICES_API_URL, store_id: 'laox', business_date: '2026-09-09',
    fetched_at: SAME_DAY, received_count: 1, used: 1, skipped: [], error: null,
    stores: {
      laox: { url: BLUE_ROCKET_PRICES_API_URL, received_count: 1, selected_count: 1, error: null },
      akihabara: { url: BLUE_ROCKET_AKIHABARA_PRICES_API_URL, received_count: 0, selected_count: 0, error: null },
    },
  });
  expect(result.snapshot.report.unmatched).toEqual([]);
  expect(fetchShinsokuPostalProducts).toHaveBeenCalledWith();
  expect(fetchBlueRocketPsaPrices).toHaveBeenCalledTimes(2);
  expect(fetchBlueRocketPsaPrices).toHaveBeenNthCalledWith(1);
  expect(fetchBlueRocketPsaPrices).toHaveBeenNthCalledWith(2, 'akihabara');
  expect(fetchExtorecaBoxSheet).toHaveBeenCalledTimes(1);
  expect(fetchExtorecaPsaSheet).toHaveBeenCalledTimes(1);
});

test.each([
  ['higher Akihabara duplicate', 140000, 150000, 'api:akihabara:3', 150000],
  ['lower Akihabara duplicate', 140000, 120000, 'api:laox:2', 140000],
  ['tied duplicate', 140000, 140000, 'api:laox:2', 140000],
] as const)('merges %s deterministically before source comparison', async (_label, laoxPrice, akihabaraPrice,
  expectedId, expectedPrice) => {
  mockBlueRocketStores(
    { ...LAOX, itemCount: laoxPrice ? 1 : 0, rows: laoxPrice ? [{ ...LAOX.rows[0], price: laoxPrice }] : [] },
    { ...AKIHABARA_EMPTY, itemCount: 1, rows: [{ id: 'api:akihabara:3', name: 'カイ', modelNumber: '236/172',
      price: akihabaraPrice, imageUrl: null }] },
  );
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  const product = result.products.find(row => row.model_number === '236/172')!;
  expect(product.origins.filter(origin => origin.source === 'blue_rocket')).toEqual([
    expect.objectContaining({ id: expectedId, rawPrice: expectedPrice, observedAt: SAME_DAY }),
  ]);
});

test('an Akihabara-only product reaches the prepared snapshot with its provenance', async () => {
  mockBlueRocketStores({ ...LAOX, itemCount: 0, rows: [] }, {
    ...AKIHABARA_EMPTY, itemCount: 1,
    rows: [{ id: 'api:akihabara:7', name: 'ミュウ', modelNumber: '205/165', price: 150000, imageUrl: null }],
  });
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.products.find(row => row.name === 'ミュウ')).toMatchObject({
    model_number: '205/165', source_price: 150000, selected_high_source: 'blue_rocket', price_high: 130000,
    origins: [expect.objectContaining({ id: 'api:akihabara:7', rawPrice: 150000, observedAt: SAME_DAY })],
  });
});

test.each([
  ['failure', 'laox'], ['failure', 'akihabara'], ['stale', 'laox'], ['stale', 'akihabara'],
] as const)('a %s in %s keeps the other Blue Rocket store eligible', async (condition, affectedStore) => {
  const healthyStore = affectedStore === 'laox' ? 'akihabara' : 'laox';
  const resultFor = (store: 'laox' | 'akihabara'): BlueRocketPsaPrices => ({
    storeId: store, businessDate: condition === 'stale' && store === affectedStore ? '2026-09-07' : '2026-09-09',
    fetchedAt: SAME_DAY, itemCount: 1,
    rows: [{ id: `api:${store}:${store === 'laox' ? 2 : 3}`, name: 'カイ', modelNumber: '236/172',
      price: store === healthyStore ? 150000 : 160000, imageUrl: null }],
  });
  jest.mocked(fetchBlueRocketPsaPrices).mockImplementation(async store => {
    const requested = store ?? 'laox';
    if (condition === 'failure' && requested === affectedStore) throw new Error(`${requested} unavailable`);
    return resultFor(requested);
  });
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  const product = result.products.find(row => row.model_number === '236/172')!;
  expect(product.origins.filter(origin => origin.source === 'blue_rocket')).toEqual([
    expect.objectContaining({ id: expect.stringMatching(`^api:${healthyStore}:`), rawPrice: 150000 }),
  ]);
  expect(result.snapshot.report.blue_rocket_psa.stores[affectedStore].error).toContain(
    condition === 'failure' ? 'unavailable' : '営業日が許容範囲外');
  expect(result.snapshot.report.blue_rocket_psa.stores[healthyStore]).toMatchObject({ selected_count: 1, error: null });
});

// ブルーロケットのAPIが取れない日は、ブルーロケット PSA が比較に参加しないだけで掲載全体は止めない。
test('both Blue Rocket API failures only remove Blue Rocket PSA from the comparison', async () => {
  jest.mocked(fetchBlueRocketPsaPrices).mockRejectedValue(new Error('ブルーロケット買取APIの取得失敗: HTTP 401'));
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.snapshot.report.source_counts).toMatchObject({ kecak: 1, blue_rocket: 1, shinsoku: 1 });
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({
    used: 0, error: expect.stringContaining('laox: ブルーロケット買取APIの取得失敗: HTTP 401'),
    stores: {
      laox: { error: 'ブルーロケット買取APIの取得失敗: HTTP 401' },
      akihabara: { error: 'ブルーロケット買取APIの取得失敗: HTTP 401' },
    },
  });
  expect(result.products[0].origins.map(origin => origin.source)).toEqual(['kecak', 'shinsoku']);
});

test('an Extoreca tab failure is explicit while the other tab still joins the comparison', async () => {
  jest.mocked(fetchExtorecaBoxSheet).mockRejectedValue(new Error('エクストレカBOX表の取得失敗: HTTP 503'));
  jest.mocked(fetchExtorecaPsaSheet).mockResolvedValue([
    { id: 'sheet:psa10:2', name: 'カイ', modelNumber: '236/172', price: 140000, productType: 'PSA10' },
  ]);
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.products[0]).toMatchObject({ source_price: 140000, selected_high_source: 'extoreca', price_high: 120000 });
  expect(result.snapshot.report.source_counts).toMatchObject({ extoreca: 1 });
  expect(result.snapshot.report.extoreca).toMatchObject({
    box: { used: 0, error: 'エクストレカBOX表の取得失敗: HTTP 503' },
    psa: { used: 1, skipped: [], error: null },
  });
});

// 翌日になり KECAK のオーダーリストも買取チェッカーも前日のまま、という実運用で起きる状況。
const nextDay = new Date('2026-09-09T20:00:00Z'); // JST 2026-09-10 05:00

test('the approved 1-day window lets previous-day prices keep competing', async () => {
  const result = await buildTokyoBuybackSnapshot(database([completed]), nextDay);
  expect(result.snapshot.business_date).toBe('2026-09-10');
  expect(result.snapshot.report.source_counts).toEqual({
    kecak: 1, blue_rocket: 2, extoreca: 0, toreca_bank: 0, avirile: 0, shinsoku: 1 });
  expect(result.products[0]).toMatchObject({ id: 'IAP1', source_price: 130000, selected_high_source: 'kecak' });
});

test('setting the window back to same-day only drops every previous-day price', async () => {
  const db = database([completed], OFFERS, { tokyo_price_max_age_days: 0 });
  mockBlueRocketStores({
    storeId: 'laox', businessDate: '2026-09-10', fetchedAt: nextDay.toISOString(), itemCount: 1,
    rows: [{ id: 'api:laox:2', name: 'カイ', modelNumber: '236/172', price: 125000, imageUrl: null }],
  });
  const result = await buildTokyoBuybackSnapshot(db, nextDay);
  // 当日営業日のAPI価格を使う。前日の KECAK と買取チェッカーは外れる。
  expect(result.snapshot.report.source_counts).toEqual({
    kecak: 0, blue_rocket: 1, extoreca: 0, toreca_bank: 0, avirile: 0, shinsoku: 1 });
  expect(result.products.map(product => [product.id, product.source_price, product.selected_high_source])).toEqual([
    ['IAP1', 125000, 'blue_rocket'],
  ]);
  expect(result.products[0].origins.map(origin => origin.source)).toEqual(['blue_rocket', 'shinsoku']);
});

test.each(['2026-09-07', '2026-09-10'])('stale or future Blue Rocket business date %s is excluded even if fetched today', async businessDate => {
  mockBlueRocketStores({
    storeId: 'laox', businessDate, fetchedAt: now.toISOString(), itemCount: 1,
    rows: [{ id: 'api:laox:2', name: 'カイ', modelNumber: '236/172', price: 140000, imageUrl: null }],
  });
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.products[0].origins.map(origin => origin.source)).toEqual(['kecak', 'shinsoku']);
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({
    business_date: businessDate, used: 0, error: expect.stringContaining('営業日が許容範囲外'),
  });
});

test('a same-day-only policy excludes the previous API business date', async () => {
  const result = await buildTokyoBuybackSnapshot(
    database([completed], OFFERS, { tokyo_price_max_age_days: 0 }), nextDay);
  expect(result.products[0].origins.map(origin => origin.source)).toEqual(['shinsoku']);
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({
    business_date: '2026-09-09', used: 0, error: expect.stringContaining('営業日が許容範囲外'),
  });
});

test('API prices enter Tokyo pricing with the existing discount and product matching', async () => {
  mockBlueRocketStores(parseBlueRocketPsaPrices({
    storeId: 'laox', storeCode: 'laox', businessDate: '2026-09-09', fetchedAt: SAME_DAY,
    items: [
      { productId: 99, name: 'PSA10 カイ SAR [s12a 236/172]', cardNumber: '236/172',
        price: 150000, remainingQty: 1, kind: null, gradeLabel: null, status: 'available', imageUrl: null },
      { productId: 100, name: 'PSA10 カイ SAR [s12a 236/172]', cardNumber: '236/172',
        price: 200000, remainingQty: 0, kind: null, gradeLabel: null, status: 'closed', imageUrl: null },
    ],
  }));
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.products[0]).toMatchObject({
    // 150,000円から既存の10%減額・1万円単位の端数処理を適用する。
    id: 'IAP1', source_price: 150000, selected_high_source: 'blue_rocket', price_high: 130000,
  });
  expect(result.products[0].origins.find(origin => origin.source === 'blue_rocket')).toMatchObject({
    id: 'api:laox:99', rawPrice: 150000, observedAt: SAME_DAY,
  });
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({ received_count: 2, used: 1, error: null });
});

test('an out-of-range window fails closed before any price is computed', async () => {
  const db = database([completed], OFFERS, { tokyo_price_max_age_days: 31 });
  await expect(buildTokyoBuybackSnapshot(db, now)).rejects.toThrow('許容経過日数は0〜30日');
});

test.each([
  { rows: [] }, { rows: [{ ...completed, status: 'running' }] },
  { rows: [{ ...completed, completed_at: '2026-09-01T03:29:59Z' }] }, { rows: [{ ...completed, product_count: 3 }] },
])('Tokyo generates independently of absent, stale, or incomplete global checker data: %j', async ({ rows }) => {
  const db = database(rows);
  const result = await buildTokyoBuybackSnapshot(db, now);
  expect(result.products.find(product => product.product_type === 'box')?.source_price).toBe(40000);
  expect(jest.mocked(db.from).mock.calls.every(([table]) => !String(table).startsWith('kaitori_checker_'))).toBe(true);
});

test('a required shop API failure is explicit and cannot reuse old global prices', async () => {
  jest.mocked(fetchCheckerShops).mockRejectedValue(new Error('買取チェッカーの店舗価格取得失敗: shop=11, HTTP 503'));
  await expect(buildTokyoBuybackSnapshot(database([completed]), now)).rejects.toThrow('shop=11, HTTP 503');
  expect(fetchShinsokuPostalProducts).not.toHaveBeenCalled();
  expect(fetchBlueRocketPsaPrices).not.toHaveBeenCalled();
});

test('all five Blue Rocket BOX shops compete by exact product, with stable ties and shop provenance', async () => {
  const checker = await jest.mocked(fetchCheckerShops)([11, 44, 51, 54, 55], [2]);
  checker.offers = [55, 51, 44, 54, 11].map(shopId => ({ ...checker.offers[0], shop_id: shopId,
    shop_name: `Blue Rocket ${shopId}`, buy_price: [51, 55].includes(shopId) ? 50000 : 40000 }));
  jest.mocked(fetchCheckerShops).mockClear().mockResolvedValue(checker);
  const result = await buildTokyoBuybackSnapshot(database([]), now);
  const boxes = result.products.filter(product => product.product_type === 'box');
  expect(boxes).toHaveLength(1);
  expect(boxes[0]).toMatchObject({ source_price: 50000, selected_high_source: 'blue_rocket',
    origins: [expect.objectContaining({ shopId: 51, shopName: 'Blue Rocket 51', rawPrice: 50000 })] });
});

test('each Blue Rocket shop can supply the winning BOX quote', () => {
  const products = [{ source_product_id: 1, category: 'pokemon', name: 'BOX', full_name: null, model_number: null }];
  for (const shopId of [11, 44, 51, 54, 55]) {
    const candidates = tokyoProductCandidates([], products, [{ source_product_id: 1, shop_id: shopId,
      condition_id: 2, edition_id: 0, buy_price: 50000, source_updated_at: SAME_DAY }], { businessDate: '2026-09-09' });
    expect(candidates).toEqual([expect.objectContaining({ source: 'blue_rocket', sourcePrice: 50000, shopId })]);
  }
});

test('a stale higher quote cannot beat another shop, and editions remain distinct', () => {
  const products = [{ source_product_id: 1, category: 'pokemon', name: 'BOX', full_name: null, model_number: null }];
  const base = { source_product_id: 1, condition_id: 2, edition_id: 0, buy_price: 40000, source_updated_at: SAME_DAY };
  const candidates = tokyoProductCandidates([], products, [
    { ...base, shop_id: 11 }, { ...base, shop_id: 44, buy_price: 60000, source_updated_at: PREVIOUS_DAY },
    { ...base, shop_id: 51, edition_id: 7, edition_name: '別版', buy_price: 50000 },
  ], { businessDate: '2026-09-09' });
  expect(candidates.map(row => [row.id, row.shopId, row.sourcePrice])).toEqual([
    ['1:2:0', 11, 40000], ['1:2:7', 51, 50000],
  ]);
});
