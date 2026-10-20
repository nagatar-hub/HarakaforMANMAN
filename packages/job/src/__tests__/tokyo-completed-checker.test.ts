import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShinsokuPostalProducts } from '@haraka/shared';
import { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';
import { BLUE_ROCKET_PRICES_API_URL, fetchBlueRocketPsaPrices, parseBlueRocketPsaPrices } from '../lib/blue-rocket';
import { fetchExtorecaBoxSheet, fetchExtorecaPsaSheet } from '../lib/extoreca-sheet';

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
  jest.mocked(fetchShinsokuPostalProducts).mockReset().mockResolvedValue([
    { id: 'IAP1', franchise: 'Pokemon', name: 'カイ', modelNumber: '236/172', productType: 'PSA10', price: 123000, imageUrl: null },
  ]);
  jest.mocked(fetchBlueRocketPsaPrices).mockReset().mockResolvedValue({
    storeId: 'laox', businessDate: '2026-09-09', fetchedAt: SAME_DAY, itemCount: 1,
    rows: [{ id: 'api:laox:2', name: 'カイ', modelNumber: '236/172', price: 125000, imageUrl: null }],
  });
  jest.mocked(fetchExtorecaBoxSheet).mockReset().mockResolvedValue([]);
  jest.mocked(fetchExtorecaPsaSheet).mockReset().mockResolvedValue([]);
});

test.each(['running', 'cancelled', 'failed'])('Tokyo uses the last applied checker while the newest is %s, and compares KECAK, Shinsoku and Blue Rocket', async status => {
  const db = database([completed, { ...completed, id: 'newest', status, created_at: '2026-09-09T02:59:00Z', completed_at: null }]);
  const result = await buildTokyoBuybackSnapshot(db, now);
  expect(result.snapshot.checker_run_id).toBe('complete');
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
  });
  expect(result.snapshot.report.unmatched).toEqual([]);
  expect(fetchShinsokuPostalProducts).toHaveBeenCalledWith();
  expect(fetchBlueRocketPsaPrices).toHaveBeenCalledTimes(1);
  expect(fetchExtorecaBoxSheet).toHaveBeenCalledTimes(1);
  expect(fetchExtorecaPsaSheet).toHaveBeenCalledTimes(1);
});

// ブルーロケットのAPIが取れない日は、ブルーロケット PSA が比較に参加しないだけで掲載全体は止めない。
test('a Blue Rocket API failure only removes Blue Rocket PSA from the comparison', async () => {
  jest.mocked(fetchBlueRocketPsaPrices).mockRejectedValue(new Error('ブルーロケット買取APIの取得失敗: HTTP 401'));
  const result = await buildTokyoBuybackSnapshot(database([completed]), now);
  expect(result.snapshot.report.source_counts).toMatchObject({ kecak: 1, blue_rocket: 1, shinsoku: 1 });
  expect(result.snapshot.report.blue_rocket_psa).toMatchObject({ used: 0, error: 'ブルーロケット買取APIの取得失敗: HTTP 401' });
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
  jest.mocked(fetchBlueRocketPsaPrices).mockResolvedValue({
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
  jest.mocked(fetchBlueRocketPsaPrices).mockResolvedValue({
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
  jest.mocked(fetchBlueRocketPsaPrices).mockResolvedValue(parseBlueRocketPsaPrices({
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
  [[], '最新取得が完了していません'],
  [[{ ...completed, status: 'running' }], '最新取得が完了していません'],
  [[{ ...completed, completed_at: '2026-09-08T03:29:59Z' }], '24時間以上'],
  [[{ ...completed, product_count: 3 }], '保存件数'],
])('Tokyo still rejects absent, stale, or incomplete checker data', async (rows, message) => {
  await expect(buildTokyoBuybackSnapshot(database(rows), now)).rejects.toThrow(message);
  expect(fetchShinsokuPostalProducts).not.toHaveBeenCalled();
  expect(fetchBlueRocketPsaPrices).not.toHaveBeenCalled();
});
