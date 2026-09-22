import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchShinsokuPostalProducts } from '@haraka/shared';
import { buildTokyoBuybackSnapshot } from '../jobs/tokyo-buyback-sync';

jest.mock('@haraka/shared', () => ({
  ...jest.requireActual('@haraka/shared'), fetchShinsokuPostalProducts: jest.fn(),
}));

const now = new Date('2026-09-09T03:30:00Z');
const completed = { id: 'complete', store: 'oripark', status: 'applied',
  created_at: '2026-09-08T22:06:00Z', completed_at: '2026-09-08T23:40:00Z', product_count: 2, offer_count: 5 };
const SAME_DAY = '2026-09-09T02:00:00Z';
const PREVIOUS_DAY = '2026-09-08T02:00:00Z';

// shop 3 = トレカバンク / 11 = Blue Rocket / 13 = アヴィリール / 22 = 対象外
const OFFERS = [
  { source_product_id: 1, shop_id: 3, buy_price: 120000, source_updated_at: SAME_DAY },
  { source_product_id: 1, shop_id: 11, buy_price: 125000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 13, buy_price: 40000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 22, buy_price: 15000000, source_updated_at: SAME_DAY },
  { source_product_id: 21461, shop_id: 3, buy_price: 90000000, source_updated_at: PREVIOUS_DAY },
];

function database(checkerRows: object[], offers = OFFERS) {
  const tables: Record<string, any[]> = {
    order_list_import: [{ id: 'order', store: 'manman-akihabara', business_date: '2026-09-09',
      structural_valid: true, persistence_complete: true, status: 'applied' }],
    kaitori_checker_sync_run: checkerRows,
    store_config: [{ store: 'manman-akihabara', settings: { psa10_discount_rates: { Pokemon: 0.04 } } }],
    order_list_item: [{ id: 'k', import_id: 'order', excel_product_id: 'k', franchise: 'Pokemon', card_name: 'カイ',
      list_no: '236/172', grade: 'PSA10', match_status: 'matched', source_price: 130000 }],
    kaitori_checker_product_snapshot: [
      { source_product_id: 1, category: 'pokemon', name: 'カイ', model_number: '236/172' },
      { source_product_id: 21461, category: 'pokemon', name: 'エーフィ☆', model_number: '025/PLAY' },
    ].map(row => ({ ...row, run_id: 'complete', store: 'oripark' })),
    kaitori_checker_offer_snapshot: offers.map(row => ({ ...row, run_id: 'complete', store: 'oripark', condition_id: 1, edition_id: 0 })),
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
});

test.each(['running', 'cancelled', 'failed'])('Tokyo uses the last applied checker while the newest is %s, and compares all five sources', async status => {
  const db = database([completed, { ...completed, id: 'newest', status, created_at: '2026-09-09T02:59:00Z', completed_at: null }]);
  const result = await buildTokyoBuybackSnapshot(db, now);
  expect(result.snapshot.checker_run_id).toBe('complete');
  expect(result.snapshot.business_date).toBe('2026-09-09');
  expect(result.snapshot.report.source_counts).toEqual({
    kecak: 1, blue_rocket: 1, toreca_bank: 1, avirile: 1, shinsoku: 1 });
  // KECAK 130,000 @5% beats Blue Rocket 125,000 @10%, Shinsoku 123,000 @5% and the bank's 120,000 @10%.
  expect(result.products.map(product => [product.id, product.source_price, product.price_high, product.selected_high_source])).toEqual([
    ['IAP1', 130000, 120000, 'kecak'],
    [expect.stringMatching(/^TOKYO_[0-9a-f]{64}$/), 40000, 36000, 'avirile'],
  ]);
  // The 90,000,000 bank row carries the previous business date and never reaches a published price.
  expect(result.snapshot.report.unmatched).toEqual([]);
  expect(fetchShinsokuPostalProducts).toHaveBeenCalledWith();
});

test('Tokyo fails closed when any of the five sources has no same-day price', async () => {
  const offers = OFFERS.filter(offer => offer.shop_id !== 11);
  const db = database([{ ...completed, offer_count: offers.length }], offers);
  await expect(buildTokyoBuybackSnapshot(db, now)).rejects.toThrow('Blue Rocketの当日価格がありません');
});

test.each([
  [[], '最新取得が完了していません'],
  [[{ ...completed, status: 'running' }], '最新取得が完了していません'],
  [[{ ...completed, completed_at: '2026-09-08T03:29:59Z' }], '24時間以上'],
  [[{ ...completed, product_count: 3 }], '保存件数'],
])('Tokyo still rejects absent, stale, or incomplete checker data', async (rows, message) => {
  await expect(buildTokyoBuybackSnapshot(database(rows), now)).rejects.toThrow(message);
  expect(fetchShinsokuPostalProducts).not.toHaveBeenCalled();
});
