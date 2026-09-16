import { buildTokyoPelekaCatalog, publishTokyoPelekaCatalog } from '../lib/peleka-catalog';

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
      card_name: 'BOX', grade: '未開封BOX', tag: 'BOX', list_no: null })] });
  expect(payload.store).toBe('manman-akihabara');
  expect(payload.products.map(product => product.sourceId)).toEqual(['source-1', 'source-2']);
  expect(payload.products[0].productType).toBe('BOX');
  expect(payload.count).toBe(2);
  expect(payload.productsSha256).toMatch(/^[a-f0-9]{64}$/);
});

test('rejects duplicate identities and a failed receiver response', async () => {
  expect(() => buildTokyoPelekaCatalog({ runId: 'run', snapshotId: 'snapshot', businessDate: '2026-09-08',
    generatedAt: '2026-09-08T01:00:00Z', cards: [card(), card({ id: 'prepared-2' })] })).toThrow('sourceId重複');
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => new Response('rejected', { status: 409 }));
  try {
    const payload = buildTokyoPelekaCatalog({ runId: 'run', snapshotId: 'snapshot', businessDate: '2026-09-08',
      generatedAt: '2026-09-08T01:00:00Z', cards: [card()] });
    await expect(publishTokyoPelekaCatalog('https://example.invalid/catalog', 'secret', payload))
      .rejects.toThrow('HTTP 409 rejected');
    expect(global.fetch).toHaveBeenCalledWith('https://example.invalid/catalog', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: JSON.stringify(payload),
    }));
  } finally { global.fetch = originalFetch; }
});
