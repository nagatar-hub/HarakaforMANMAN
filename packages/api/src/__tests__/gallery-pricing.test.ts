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
        order_list_import_id: `order-${id}`, business_date: '2026-09-17', report: {
          order_business_date: id === 'old' ? '2026-09-16' : '2026-09-17',
          ...(id === 'new' ? { price_sources: { IAP1: { source: 'shinsoku', price: 2000 } } } : {}),
        } }));
    } else if (table === 'tokyo_buyback_product') {
      const old = q.get('snapshot_id') === 'eq.old';
      data = [{ id: 'IAP1', source_price: old ? 1000 : 2000, origins: [
        { source: 'kecak', id: 'K1', sourcePrice: old ? 1500 : 2000 }, { source: 'kecak', id: 'K2' },
        { source: 'avirile', id: '42:1:7' }, { source: 'toreca_bank', id: '42:1:0' },
        { source: 'avirile', id: '42:2:7' }, { source: 'toreca_bank', id: '42:2:0' }, { source: 'toreca_bank', id: '42:2:8' },
      ] }];
    } else if (table === 'kaitori_checker_offer_snapshot') {
      assert.equal(q.get('store'), 'eq.oripark');
      assert.equal(q.get('shop_id'), 'in.(3,13)');
      assert.equal(q.get('source_product_id'), 'in.(42)');
      const old = q.get('run_id') === 'eq.checker-old';
      assert.ok(old || q.get('run_id') === 'eq.checker-new');
      const current = '2026-09-16T15:00:00.000Z';
      const previous = '2026-09-16T14:59:59.999Z';
      data = [
        { source_product_id: 42, shop_id: 13, condition_id: 1, edition_id: 0, buy_price: 999999, source_updated_at: old ? previous : current },
        { source_product_id: 42, shop_id: 13, condition_id: 2, edition_id: 7, buy_price: 888888, source_updated_at: previous },
        { source_product_id: 42, shop_id: 13, condition_id: 1, edition_id: 7, buy_price: old ? 3000 : 4000, source_updated_at: old ? previous : current },
        { source_product_id: 42, shop_id: 3, condition_id: 1, edition_id: 0, buy_price: old ? 0 : 5000, source_updated_at: old ? previous : current },
        { source_product_id: 42, shop_id: 3, condition_id: 2, edition_id: 0, buy_price: 6000, source_updated_at: null },
        { source_product_id: 42, shop_id: 3, condition_id: 2, edition_id: 8, buy_price: 7000, source_updated_at: '2026-09-17T15:00:00.000Z' },
      ];
    } else if (table === 'order_list_import') {
      const old = q.get('id') === 'eq.order-old';
      assert.ok(old || q.get('id') === 'eq.order-new');
      assert.equal(q.get('store'), 'eq.manman-akihabara');
      data = { id: old ? 'order-old' : 'order-new', business_date: old ? '2026-09-16' : '2026-09-17' };
    } else if (table === 'order_list_item') {
      assert.equal(q.get('import_id'), 'eq.order-new', 'must not read previous-day KECAK prices');
      assert.equal(q.get('excel_product_id'), 'in.(K2)');
      data = [{ id: 'order-row', excel_product_id: 'K2', source_price: 1600 }];
    } else throw new Error(`Unexpected table ${table}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await galleryRoutes.request('/gallery/pages/page', { headers: { Authorization: `Bearer ${'t'.repeat(32)}` } });
    assert.equal(response.status, 200);
    const payload = await response.json() as { cards: any[] };
    assert.deepEqual(payload.cards.map(card => card.id), ['b', 'a', 'manual']);
    assert.deepEqual(payload.cards[0].pricing, { listings: [
      { store: 'KECAK', price: 2000 }, { store: 'KECAK', price: 1600 },
      { store: 'アヴィリール', price: 4000 }, { store: 'トレカバンク', price: 5000 },
    ], adopted: { store: 'シンソク郵送買取', price: 2000 } });
    assert.deepEqual(payload.cards[1].pricing, { listings: [], adopted: { store: null, price: 1000 } });
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

test('five-source snapshots expose the per-store comparison and fall back when a selected source is missing', async () => {
  const { galleryRoutes } = await import('../routes/gallery.js');
  const savedFetch = globalThis.fetch;
  const origins = [
    { source: 'kecak', id: 'K1', sourcePrice: 110000, rawPrice: 110000, highRate: 0.05, highPrice: 100000, lowRate: 0.05, lowPrice: 100000 },
    { source: 'toreca_bank', id: '42:1:0', sourcePrice: 100000, rawPrice: 100000, highRate: 0.1, highPrice: 90000, lowRate: 0.1, lowPrice: 90000, excluded: true },
    { source: 'shinsoku', id: 'IAP1', sourcePrice: 100000, rawPrice: 100000, highRate: 0.05, highPrice: 95000, lowRate: 0.05, lowPrice: 95000 },
  ];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const q = url.searchParams;
    let data: unknown;
    if (table === 'generated_page') data = { id: 'page', run_id: 'r', card_ids: ['c1', 'c2'] };
    else if (table === 'run') data = q.get('id')?.startsWith('eq.') ? { id: 'r' } : [{ id: 'r', tokyo_snapshot_id: 's' }];
    else if (table === 'prepared_card') data = [
      { id: 'c1', run_id: 'r', source_shinsoku_id: 'IAP1', price_high: 100000 },
      { id: 'c2', run_id: 'r', source_shinsoku_id: 'IAP2', price_high: 45000 },
    ].map(card => Object.fromEntries(Object.entries(card).filter(([key]) => q.get('select')!.split(',').map(x => x.trim()).includes(key))));
    else if (table === 'tokyo_buyback_snapshot') data = [{ id: 's', checker_run_id: 'checker', checker_source_store: 'oripark',
      order_list_import_id: 'order', business_date: '2026-09-17',
      report: { order_business_date: '2026-09-17', price_sources: { IAP2: { source: 'shinsoku', price: 50000 } } } }];
    else if (table === 'tokyo_buyback_product') data = [
      { id: 'IAP1', source_price: 110000, price_high: 100000, price_low: 95000,
        selected_high_source: 'kecak', selected_low_source: 'shinsoku', origins },
      // A selected source absent from origins must never invent a comparison row.
      { id: 'IAP2', source_price: 50000, price_high: 45000, price_low: 45000,
        selected_high_source: 'blue_rocket', selected_low_source: 'blue_rocket',
        origins: [{ source: 'shinsoku', id: 'IAP2', sourcePrice: 50000, rawPrice: 50000, highRate: 0.05, highPrice: 47000, lowRate: 0.05, lowPrice: 47000 }] },
    ];
    else if (table === 'order_list_import') data = { id: 'order', business_date: '2026-09-17' };
    else if (table === 'kaitori_checker_offer_snapshot') data = [];
    else throw new Error(`Unexpected table ${table}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await galleryRoutes.request('/gallery/pages/page', { headers: { Authorization: `Bearer ${'t'.repeat(32)}` } });
    assert.equal(response.status, 200);
    const payload = await response.json() as { cards: any[] };
    assert.deepEqual(payload.cards.map(card => card.id), ['c1', 'c2']);
    assert.deepEqual(payload.cards[0].pricing, {
      listings: [{ store: 'KECAK', price: 110000 }, { store: 'トレカバンク', price: 100000 },
        { store: 'シンソク郵送買取', price: 100000 }],
      adopted: { store: 'KECAK', price: 110000 },
      comparison: {
        rows: [
          { store: 'KECAK', rawPrice: 110000, highRate: 0.05, highPrice: 100000, lowRate: 0.05, lowPrice: 100000, selectedHigh: true, selectedLow: false, excluded: false },
          { store: 'トレカバンク', rawPrice: 100000, highRate: 0.1, highPrice: 90000, lowRate: 0.1, lowPrice: 90000, selectedHigh: false, selectedLow: false, excluded: true },
          { store: 'シンソク郵送買取', rawPrice: 100000, highRate: 0.05, highPrice: 95000, lowRate: 0.05, lowPrice: 95000, selectedHigh: false, selectedLow: true, excluded: false },
        ],
        high: { store: 'KECAK', price: 100000 },
        low: { store: 'シンソク郵送買取', price: 95000 },
      },
    });
    assert.equal('comparison' in payload.cards[1].pricing, false);
    assert.deepEqual(payload.cards[1].pricing.adopted, { store: 'シンソク郵送買取', price: 50000 });
  } finally { globalThis.fetch = savedFetch; }
});
