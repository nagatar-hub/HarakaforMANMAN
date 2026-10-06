import { runRefreshPelekaPostal } from '../jobs/refresh-peleka-postal';

let db: any;
let rows: Record<string, any[]>;
let postalSnapshot: any;
let renderFailure: Error | null;

jest.mock('../lib/supabase', () => ({ createSupabaseClientFromSecrets: async () => db }));
jest.mock('../lib/env', () => ({ getRequiredEnvOrSecret: async (name: string) => name.includes('URL')
  ? 'https://peleka.invalid/catalog' : 'token' }));
jest.mock('../lib/peleka-postal', () => {
  const actual = jest.requireActual('../lib/peleka-postal');
  return { ...actual, fetchTokyoPelekaPostalSnapshot: jest.fn() };
});
jest.mock('../lib/tokyo-peleka-postal-render', () => ({
  renderTokyoPelekaPostalPages: jest.fn(async ({ snapshot, publishTogether }) => {
    if (renderFailure) throw renderFailure;
    const pages = snapshot.products.length ? [{
      id: '90000000-0000-4000-8000-000000000001',
      run_id: snapshot.runId,
      franchise: 'Pokemon', page_index: 0, page_label: 'PSA10', card_ids: ['card-1'],
      kind: 'postal', status: 'generated', display_name: '郵送買取 Pokemon PSA10 (1).png',
      image_key: 'generated/new.png', image_url: 'https://images.invalid/new.png',
      peleka_snapshot: snapshot,
    }] : [];
    await publishTogether(pages);
    return pages.length;
  }),
}));

const runId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const snapshotId = '30000000-0000-4000-8000-000000000001';

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, store: 'manman-akihabara', runId, snapshotId, revision: 2,
    businessDate: '2026-10-06', generatedAt: '2026-10-06T01:00:00Z',
    buyPriceDisplayMode: 'RANGE', boxBuybackEnabled: false, fingerprint: 'a'.repeat(32),
    products: [{ sourceId: 'source-1', franchise: 'Pokemon', productType: 'PSA10', name: 'ピカチュウ',
      modelNumber: '001', imageUrl: 'https://images.invalid/card.png', priceHigh: 1500, priceLow: 1200 }],
    ...overrides,
  };
}

function database() {
  const tables: Record<string, any[]> = {
    tokyo_peleka_postal_refresh: [{ run_id: runId, request_id: requestId, status: 'running' }],
    run: [{ id: runId, store: 'manman-akihabara', status: 'completed', generate_done_at: '2026-10-06T02:00:00Z',
      tokyo_snapshot_id: snapshotId }],
    tokyo_buyback_snapshot: [{ id: snapshotId, store: 'manman-akihabara', business_date: '2026-10-06' }],
    generated_page: [
      { id: 'store-1', run_id: runId, kind: 'store', status: 'generated', card_ids: ['card-1'] },
      { id: 'postal-old', run_id: runId, kind: 'postal', status: 'generated', card_ids: ['card-1'] },
    ],
    tokyo_peleka_catalog_revisions: [{ run_id: runId, last_revision: 2 }],
    prepared_card: [{ id: 'card-1', run_id: runId, source_shinsoku_id: 'source-1', franchise: 'Pokemon',
      card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001', image_url: 'https://store.invalid/card.png',
      alt_image_url: null, tag: 'PSA10', price_high: 1000, price_low: 800 }],
  };
  const rpc = jest.fn(async () => ({ error: null }));
  const client = { rpc, from(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    const query: any = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      in: (key: string, values: unknown[]) => { filters.push(row => values.includes(row[key])); return query; },
      maybeSingle: async () => ({ data: (tables[table] ?? []).filter(row => filters.every(filter => filter(row)))[0] ?? null, error: null }),
      then: (resolve: any, reject: any) => Promise.resolve({
        data: (tables[table] ?? []).filter(row => filters.every(filter => filter(row))), error: null,
      }).then(resolve, reject),
    };
    return query;
  } };
  return { client, rpc, tables };
}

beforeEach(() => {
  process.env.STORE_NAME = 'manman-akihabara';
  process.env.RUN_ID = runId;
  process.env.POSTAL_REFRESH_REQUEST_ID = requestId;
  postalSnapshot = makeSnapshot();
  renderFailure = null;
  const boundary = database();
  db = boundary.client;
  rows = boundary.tables;
  const fetchSnapshot = require('../lib/peleka-postal').fetchTokyoPelekaPostalSnapshot;
  fetchSnapshot.mockReset().mockImplementation(async () => postalSnapshot);
});

test('refresh uses latest allocated revision, Peleka prices, and atomically publishes without changing store rows', async () => {
  const before = JSON.stringify(rows.generated_page);
  await runRefreshPelekaPostal();
  const fetchSnapshot = require('../lib/peleka-postal').fetchTokyoPelekaPostalSnapshot;
  expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  expect(fetchSnapshot).toHaveBeenCalledWith('https://peleka.invalid/catalog', 'token', { runId, revision: 2 });
  const publish = db.rpc.mock.calls.find(([name]: [string]) => name === 'replace_tokyo_peleka_postal_pages');
  expect(publish).toBeDefined();
  expect(publish[1]).toMatchObject({ p_run_id: runId, p_request_id: requestId, p_expected_revision: 2,
    p_expected_fingerprint: 'a'.repeat(32) });
  expect(publish[1].p_pages[0].peleka_snapshot.products[0]).toMatchObject({ priceHigh: 1500, priceLow: 1200 });
  expect(JSON.stringify(rows.generated_page)).toBe(before);
});

test('mid-render fingerprint change fails without publication', async () => {
  const fetchSnapshot = require('../lib/peleka-postal').fetchTokyoPelekaPostalSnapshot;
  fetchSnapshot.mockResolvedValueOnce(makeSnapshot()).mockResolvedValueOnce(makeSnapshot({ fingerprint: 'b'.repeat(32) }));
  await expect(runRefreshPelekaPostal()).rejects.toThrow('画像生成中に変更');
  expect(db.rpc.mock.calls.some(([name]: [string]) => name === 'replace_tokyo_peleka_postal_pages')).toBe(false);
  expect(db.rpc.mock.calls.at(-1)[0]).toBe('fail_tokyo_peleka_postal_refresh');
});

test('render failure keeps publication untouched and records failure', async () => {
  renderFailure = new Error('image download failed');
  await expect(runRefreshPelekaPostal()).rejects.toThrow('image download failed');
  expect(db.rpc.mock.calls.some(([name]: [string]) => name === 'replace_tokyo_peleka_postal_pages')).toBe(false);
  expect(db.rpc.mock.calls.at(-1)[1].p_error_message).toBe('image download failed');
});

test('zero eligible products deliberately publishes an empty replacement', async () => {
  postalSnapshot = makeSnapshot({ products: [] });
  rows.generated_page.find(page => page.kind === 'store').card_ids = [];
  rows.prepared_card = [];
  await runRefreshPelekaPostal();
  const publish = db.rpc.mock.calls.find(([name]: [string]) => name === 'replace_tokyo_peleka_postal_pages');
  expect(publish[1].p_pages).toEqual([]);
});

test('another active Peleka run fails closed with an actionable retry message', async () => {
  require('../lib/peleka-postal').fetchTokyoPelekaPostalSnapshot.mockRejectedValue(
    new Error('Peleka郵送カタログ取得失敗: HTTP 409 stale'),
  );
  await expect(runRefreshPelekaPostal()).rejects.toThrow('Peleka同期完了後に再試行');
  expect(db.rpc.mock.calls.at(-1)[0]).toBe('fail_tokyo_peleka_postal_refresh');
});
