import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STORE_NAME = 'manman-akihabara';
process.env.ORDER_LIST_IMPORT_API_TOKEN = 't'.repeat(32);
process.env.SUPABASE_URL = 'https://gallery-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

test('gallery prices use each card historical snapshot, exact checker edition, and internal authorization', async () => {
  const { galleryRoutes } = await import('../routes/gallery.js');
  const savedFetch = globalThis.fetch;
  const calls: URL[] = [];
  const cards = [
    { id: 'a', run_id: 'old-run', source_shinsoku_id: 'IAP1', price_high: 900 },
    { id: 'b', run_id: 'page-run', source_shinsoku_id: 'IAP1', price_high: 1800 },
    { id: 'manual', run_id: 'page-run', source_shinsoku_id: null, price_high: 123 },
  ];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.host, 'gallery-test.invalid');
    calls.push(url);
    const table = url.pathname.split('/').at(-1);
    const q = url.searchParams;
    let data: unknown;
    if (table === 'generated_page') data = { id: 'page', run_id: 'page-run', card_ids: ['b', 'a', 'manual'] };
    else if (table === 'run') {
      assert.equal(q.get('store'), 'eq.manman-akihabara');
      data = q.get('id')?.startsWith('eq.') ? { id: 'page-run' }
        : [{ id: 'old-run', tokyo_snapshot_id: 'old' }, { id: 'page-run', tokyo_snapshot_id: 'new' }];
    } else if (table === 'prepared_card') data = cards.map(card => Object.fromEntries(Object.entries(card)
      .filter(([key]) => q.get('select')!.split(',').map(x => x.trim()).includes(key))));
    else if (table === 'tokyo_buyback_snapshot') {
      assert.equal(q.get('store'), 'eq.manman-akihabara');
      assert.equal(q.get('id'), 'in.(old,new)');
      assert.equal(q.has('order'), false, 'must not select latest snapshot');
      data = ['old', 'new'].map(id => ({ id, checker_run_id: `checker-${id}`, checker_source_store: 'oripark',
        order_list_import_id: `order-${id}`, report: id === 'old' ? {} : { price_sources: { IAP1: { source: 'kecak', price: 2000 } } } }));
    } else if (table === 'tokyo_buyback_product') {
      const old = q.get('snapshot_id') === 'eq.old';
      data = [{ id: 'IAP1', source_price: old ? 1000 : 2000, origins: [
        { source: 'kecak', id: 'K1', ...(old ? {} : { sourcePrice: 2000 }) },
        { source: 'avirile', id: '42:1:7' }, { source: 'toreca_bank', id: '42:1:0' },
      ] }];
    } else if (table === 'kaitori_checker_offer_snapshot') {
      assert.equal(q.get('store'), 'eq.oripark');
      assert.equal(q.get('shop_id'), 'in.(3,13)');
      assert.equal(q.get('source_product_id'), 'in.(42)');
      const old = q.get('run_id') === 'eq.checker-old';
      assert.ok(old || q.get('run_id') === 'eq.checker-new');
      data = [
        { source_product_id: 42, shop_id: 13, condition_id: 1, edition_id: 0, buy_price: 999999 },
        { source_product_id: 42, shop_id: 13, condition_id: 2, edition_id: 7, buy_price: 888888 },
        { source_product_id: 42, shop_id: 13, condition_id: 1, edition_id: 7, buy_price: old ? 3000 : 4000 },
        { source_product_id: 42, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: old ? 0 : 5000 },
      ];
    } else if (table === 'order_list_import') {
      assert.equal(q.get('id'), 'eq.order-old');
      assert.equal(q.get('store'), 'eq.manman-akihabara');
      data = { id: 'order-old' };
    } else if (table === 'order_list_item') {
      assert.equal(q.get('import_id'), 'eq.order-old');
      assert.equal(q.get('excel_product_id'), 'in.(K1)');
      data = [{ id: 'order-row', excel_product_id: 'K1', source_price: 1500 }];
    } else throw new Error(`Unexpected table ${table}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await galleryRoutes.request('/gallery/pages/page', { headers: { Authorization: `Bearer ${'t'.repeat(32)}` } });
    assert.equal(response.status, 200);
    const payload = await response.json() as { cards: any[] };
    assert.deepEqual(payload.cards.map(card => card.id), ['b', 'a', 'manual']);
    assert.deepEqual(payload.cards[0].pricing, { listings: [
      { store: 'KECAK', price: 2000 }, { store: 'アヴィリール', price: 4000 }, { store: 'トレカバンク', price: 5000 },
    ], adopted: { store: 'KECAK', price: 2000 } });
    assert.deepEqual(payload.cards[1].pricing, { listings: [
      { store: 'KECAK', price: 1500 }, { store: 'アヴィリール', price: 3000 }, { store: 'トレカバンク', price: null },
    ], adopted: { store: null, price: 1000 } });
    assert.deepEqual(payload.cards[2].pricing, { listings: [], adopted: null });
    assert.ok(payload.cards.every(card => !('run_id' in card) && !('source_shinsoku_id' in card) && !('origins' in card)));
    assert.deepEqual(payload.cards.map(card => card.price_high), [1800, 900, 123]);
    calls.length = 0;
    const anonymous = await galleryRoutes.request('/gallery/pages/page');
    assert.equal(anonymous.status, 200);
    assert.ok((await anonymous.json() as { cards: any[] }).cards.every(card => !('pricing' in card)));
    assert.ok(calls.every(call => ['run', 'prepared_card', 'generated_page'].includes(call.pathname.split('/').at(-1)!)));
  } finally { globalThis.fetch = savedFetch; }
});
