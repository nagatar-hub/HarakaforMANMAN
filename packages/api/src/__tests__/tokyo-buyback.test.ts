import assert from 'node:assert/strict';
import { test } from 'node:test';

// Each node:test file runs in its own process; never loads credentials or contacts a real service.
process.env.STORE_NAME = 'manman-akihabara';
process.env.ORDER_LIST_IMPORT_API_TOKEN = 't'.repeat(32);
process.env.SUPABASE_URL = 'https://tokyo-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-key';

test('Tokyo HTTP catalog, creation and add use one Shinsoku snapshot; legacy refresh and render stop', async () => {
  const { customBuybackRoutes } = await import('../routes/custom-buyback.js');
  const { tokyoBusinessDate } = await import('@haraka/shared');
  const savedFetch = globalThis.fetch;
  const calls: { url: URL; method: string; body: Record<string, unknown> | null }[] = [];
  let legacy = false;
  const snapshot = { id: 'snapshot', store: 'manman-akihabara', business_date: tokyoBusinessDate(),
    fetched_at: new Date().toISOString(), report: { matched: 1 } };
  const product = { snapshot_id: 'snapshot', id: 'shinsoku-1', franchise: 'Pokemon', product_type: 'psa',
    name: 'カイ', model_number: '236/172', image_url: null, source_price: 10000, price_high: 9700, origins: ['kecak'] };
  const sheet = { id: 'sheet', store: 'manman-akihabara', catalog_source: 'shinsoku', tokyo_snapshot_id: 'snapshot',
    franchise: 'Pokemon', product_type: 'psa', status: 'draft', price_business_date: snapshot.business_date };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.host, 'tokyo-test.invalid');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body });
    const table = url.pathname.split('/').at(-1);
    const data = table === 'tokyo_buyback_snapshot' ? snapshot
      : table === 'tokyo_buyback_product' ? [product]
        : table === 'custom_buyback_sheet' ? { ...sheet, ...body, ...(legacy ? { catalog_source: 'kaitori_checker' } : {}) }
          : table === 'custom_buyback_item' ? [{ source_shinsoku_id: product.id, final_price_high: 9700 }]
            : table === 'add_custom_buyback_shinsoku_items' ? null : undefined;
    assert.notEqual(data, undefined, `unexpected table/RPC ${table}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const headers = { Authorization: `Bearer ${'t'.repeat(32)}`, 'Content-Type': 'application/json' };
  try {
    const catalog = await customBuybackRoutes.request('/custom-buyback/catalog?franchise=Pokemon&product_type=psa', { headers });
    assert.equal(catalog.status, 200);
    const payload = await catalog.json() as { cards: { price_high: number; source: string }[] };
    assert.equal(payload.cards[0].price_high, 9700);
    assert.equal(payload.cards[0].source, 'shinsoku');
    assert.equal(calls[0].url.searchParams.get('store'), 'eq.manman-akihabara');
    assert.equal(calls[1].url.searchParams.get('snapshot_id'), 'eq.snapshot');
    const create = await customBuybackRoutes.request('/custom-buyback/sheets', { method: 'POST', headers,
      body: JSON.stringify({ name: '東京PSA', franchise: 'Pokemon', product_type: 'psa', kind: 'store' }) });
    assert.equal(create.status, 201);
    const inserted = calls.find(call => call.method === 'POST' && call.url.pathname.endsWith('/custom_buyback_sheet'))!.body!;
    assert.equal(inserted.catalog_source, 'shinsoku');
    assert.equal(inserted.tokyo_snapshot_id, 'snapshot');
    assert.equal(inserted.price_snapshot_run_id, null);
    assert.equal(inserted.kaitori_checker_run_id, null);
    const add = await customBuybackRoutes.request('/custom-buyback/sheets/sheet/items', { method: 'POST', headers,
      body: JSON.stringify({ catalog_ids: ['shinsoku-1'] }) });
    assert.equal(add.status, 201);
    assert.deepEqual(calls.find(call => call.url.pathname.endsWith('/add_custom_buyback_shinsoku_items'))!.body,
      { p_sheet_id: 'sheet', p_store: 'manman-akihabara', p_product_ids: ['shinsoku-1'] });
    legacy = true;
    for (const action of ['refresh-prices', 'render', 'clone']) {
      const response = await customBuybackRoutes.request(`/custom-buyback/sheets/sheet/${action}`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 409);
      assert.match((await response.json() as { error: string }).error, /新しい買取表/);
    }
    assert.ok(calls.every(call => !call.url.pathname.includes('kaitori_checker') && !call.url.pathname.includes('prepared_card')));
  } finally {
    globalThis.fetch = savedFetch;
  }
});
