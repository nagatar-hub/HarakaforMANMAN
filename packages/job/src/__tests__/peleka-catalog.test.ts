import {
  buildCurrentTokyoPelekaCatalog,
  buildTokyoPelekaCatalog,
  loadTokyoShinsokuPrices,
  publishTokyoPelekaCatalog,
} from '../lib/peleka-catalog';

const prices = new Map([['source-1', 12000], ['source-2', 31000]]);

const card = (overrides: Record<string, unknown> = {}) => ({
  id: 'prepared-1', run_id: 'run-1', source_shinsoku_id: 'source-2', raw_import_id: null,
  order_list_item_id: null, excel_product_id: null, db_card_id: null, franchise: 'ONE PIECE',
  card_name: 'チョッパー', grade: 'PSA10', list_no: 'EB01-006', image_url: 'https://example.invalid/card.png',
  alt_image_url: null, rarity: null, rarity_icon_url: null, tag: 'selected', price_high: 30000,
  price_low: 28000, image_status: 'ok', source: 'db', price_source: 'shinsoku', price_source_date: null,
  created_at: '2026-09-08T00:00:00Z', ...overrides,
} as any);

test('builds a deterministic Tokyo-only payload from the exact listed cards', () => {
  const payload = buildTokyoPelekaCatalog({ runId: 'run-1', snapshotId: 'snapshot-1', businessDate: '2026-09-08',
    generatedAt: '2026-09-08T01:00:00Z', cards: [card(), card({ id: 'prepared-2', source_shinsoku_id: 'source-1',
      card_name: 'BOX', grade: '未開封BOX', tag: 'BOX', list_no: null })], shinsokuPrices: prices });
  expect(payload.store).toBe('manman-akihabara');
  expect(payload.products.map(product => product.sourceId)).toEqual(['source-1', 'source-2']);
  expect(payload.products[0].productType).toBe('BOX');
  expect(payload.count).toBe(2);
  expect(payload.productsSha256).toMatch(/^[a-f0-9]{64}$/);
});

test('rejects duplicate identities and a failed receiver response', async () => {
  expect(() => buildTokyoPelekaCatalog({ runId: 'run', snapshotId: 'snapshot', businessDate: '2026-09-08',
    generatedAt: '2026-09-08T01:00:00Z', cards: [card(), card({ id: 'prepared-2' })], shinsokuPrices: prices })).toThrow('sourceId重複');
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response('rejected', { status: 409 }));
  try {
    const payload = buildTokyoPelekaCatalog({ runId: 'run', snapshotId: 'snapshot', businessDate: '2026-09-08',
      generatedAt: '2026-09-08T01:00:00Z', cards: [card()], shinsokuPrices: prices });
    await expect(publishTokyoPelekaCatalog('https://example.invalid/catalog', 'secret', payload))
      .rejects.toThrow('HTTP 409 rejected');
    expect(global.fetch).toHaveBeenCalledWith('https://example.invalid/catalog', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: JSON.stringify(payload),
    }));
  } finally { global.fetch = originalFetch; }
});

test('builds a revisioned payload from the database-allocated full-run snapshot', async () => {
  const rpc = jest.fn().mockResolvedValue({
    data: {
      runId: 'run-1', snapshotId: 'snapshot-1', businessDate: '2026-09-08',
      generatedAt: '2026-09-08T01:00:00Z', revision: 3, cards: [card()],
    },
    error: null,
  });
  const from = jest.fn(() => ({ select: () => ({ eq: () => ({ in: async () => ({
    data: [{ id: 'source-2', origins: [{ source: 'shinsoku', rawPrice: 31000 }] }], error: null,
  }) }) }) }));
  const payload = await buildCurrentTokyoPelekaCatalog({ rpc, from }, 'run-1');
  expect(rpc).toHaveBeenCalledWith('allocate_tokyo_peleka_catalog_revision', { p_run_id: 'run-1' });
  expect(payload).toEqual(expect.objectContaining({ runId: 'run-1', revision: 3, count: 1 }));

  expect(from).toHaveBeenCalledWith('tokyo_buyback_product');
  expect(payload.products[0]).toMatchObject({ sourceId: 'source-2', priceHigh: 30000, shinsokuPrice: 31000 });

  await buildCurrentTokyoPelekaCatalog({ rpc, from }, 'run-1', 'page-1');
  expect(rpc).toHaveBeenLastCalledWith('allocate_tokyo_peleka_catalog_revision', {
    p_run_id: 'run-1', p_regenerating_page_id: 'page-1',
  });
});

test('lists only cards with a Shinsoku price and sends that raw price', () => {
  const payload = buildTokyoPelekaCatalog({ runId: 'run', snapshotId: 'snapshot', businessDate: '2026-09-08',
    generatedAt: '2026-09-08T01:00:00Z', shinsokuPrices: new Map([['source-2', 31000]]),
    cards: [card(), card({ id: 'prepared-kecak-only', source_shinsoku_id: 'TOKYO_kecak' })] });
  expect(payload.products.map(product => [product.sourceId, product.priceHigh, product.shinsokuPrice]))
    .toEqual([['source-2', 30000, 31000]]);
  expect(payload.count).toBe(1);
});

test('reads Shinsoku raw prices from the snapshot and ignores missing or outlier-excluded ones', async () => {
  const inCalls: string[][] = [];
  const supabase = { from: () => ({ select: () => ({ eq: (_column: string, snapshotId: string) => ({
    in: async (_id: string, ids: string[]) => {
      expect(snapshotId).toBe('snapshot-1');
      inCalls.push(ids);
      return { data: [
        { id: 'IA1', origins: [{ source: 'kecak', rawPrice: 50000 }, { source: 'shinsoku', rawPrice: 40000 }] },
        { id: 'IA2', origins: [{ source: 'shinsoku', rawPrice: 90000, excluded: true }] },
        { id: 'TOKYO_x', origins: [{ source: 'blue_rocket', rawPrice: 30000 }] },
        { id: 'IA3', origins: [{ source: 'shinsoku', rawPrice: 0 }] },
      ].filter(row => ids.includes(row.id)), error: null };
    },
  }) }) }) };
  const ids = ['IA1', 'IA2', 'TOKYO_x', 'IA3', ...Array.from({ length: 100 }, (_, i) => `pad-${i}`)];
  const result = await loadTokyoShinsokuPrices(supabase, 'snapshot-1', ids);
  expect([...result]).toEqual([['IA1', 40000]]);
  expect(inCalls.map(call => call.length)).toEqual([100, 4]);
});
