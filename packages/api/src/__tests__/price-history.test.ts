import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STORE_NAME = 'manman-akihabara';
process.env.ORDER_LIST_IMPORT_API_TOKEN = 't'.repeat(32);
process.env.SUPABASE_URL = 'https://gallery-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const auth = { Authorization: `Bearer ${'t'.repeat(32)}` };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('price history requires authorization and a bounded query', async () => {
  const { galleryRoutes } = await import('../routes/gallery.js');
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not query'); };
  try {
    assert.equal((await galleryRoutes.request('/gallery/price-history?q=x')).status, 401);
    assert.equal((await galleryRoutes.request('/gallery/price-history?q=%20', { headers: auth })).status, 400);
    assert.equal((await galleryRoutes.request(`/gallery/price-history?q=${'x'.repeat(101)}`, { headers: auth })).status, 400);
  } finally { globalThis.fetch = saved; }
});

test('price history lists published regular cards and rendered custom items newest first', async () => {
  const { galleryRoutes, buildPriceHistoryOrFilter } = await import('../routes/gallery.js');
  assert.equal(buildPriceHistoryOrFilter('a"b\\c', ['card_name']), 'card_name.ilike."%a\\"b\\\\c%"');
  const saved = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    const q = url.searchParams;
    if (table === 'prepared_card') {
      assert.equal(q.get('run.store'), 'eq.manman-akihabara');
      assert.equal(q.get('run.status'), 'eq.completed');
      assert.equal(q.get('or'), '(card_name.ilike."%ピカチュウ%",list_no.ilike."%ピカチュウ%")');
      return json([
        { id: 'old', run_id: 'r1', franchise: 'Pokemon', card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001', tag: null,
          price_high: 9000, price_low: 9000, source_shinsoku_id: null, run: { started_at: '2026-09-20T01:00:00Z' } },
        { id: 'new', run_id: 'r2', franchise: 'Pokemon', card_name: 'ピカチュウ', grade: 'PSA10', list_no: '001', tag: null,
          price_high: 95000, price_low: 95000, source_shinsoku_id: 'IAP1', run: { started_at: '2026-09-23T01:00:00Z' } },
        { id: 'unpublished', run_id: 'r2', franchise: 'Pokemon', card_name: 'ピカチュウ', grade: 'PSA10', list_no: '002', tag: null,
          price_high: 1, price_low: 1, source_shinsoku_id: null, run: { started_at: '2026-09-23T01:00:00Z' } },
      ]);
    }
    if (table === 'generated_page') {
      assert.equal(q.get('status'), 'eq.generated');
      assert.equal(q.get('card_ids'), 'ov.{old,new,unpublished}');
      return json([{ card_ids: ['old'] }, { card_ids: ['new', 'other'] }]);
    }
    if (table === 'run') return json([{ id: 'r1', tokyo_snapshot_id: null }, { id: 'r2', tokyo_snapshot_id: 's' }]);
    if (table === 'tokyo_buyback_snapshot') return json([{ id: 's', checker_run_id: 'c', checker_source_store: 'oripark',
      order_list_import_id: 'o', business_date: '2026-09-23', report: {} }]);
    if (table === 'tokyo_buyback_product') return json([{ id: 'IAP1', source_price: 100000, price_high: 95000, price_low: 95000,
      selected_high_source: 'shinsoku', selected_low_source: 'shinsoku', origins: [
        { source: 'shinsoku', id: 'IAP1', rawPrice: 100000, highRate: 0.05, highPrice: 95000, lowRate: 0.05, lowPrice: 95000 },
        { source: 'toreca_bank', id: '1:1:0', rawPrice: 90000, highRate: 0.05, highPrice: 85000, lowRate: 0.05, lowPrice: 85000 },
      ] }]);
    if (table === 'order_list_import') return json({ id: 'o', business_date: '2026-09-23' });
    if (table === 'kaitori_checker_offer_snapshot') return json([]);
    if (table === 'custom_buyback_render_log') {
      assert.equal(q.get('store'), 'eq.manman-akihabara');
      assert.equal(q.get('order'), 'rendered_at.desc');
      return json([
        { id: 'log2', rendered_at: '2026-09-22T02:00:00Z', rendered_by: 'staff@example.com', sheet_name: '週末特価',
          sheet_created_by: 'owner@example.com', franchise: 'Pokemon', display_date: '2026-09-22', card_name: 'ピカチュウ',
          grade: 'PSA10', list_no: '001', tag: null, final_price_high: 99000, source_shop_name: 'KECAK',
          override_reason: '店頭調整', backfilled: false },
        { id: 'log1', rendered_at: '2026-09-21T02:00:00Z', rendered_by: null, sheet_name: '週末特価',
          sheet_created_by: 'owner@example.com', franchise: 'Pokemon', display_date: '2026-09-21', card_name: 'ピカチュウ',
          grade: 'PSA10', list_no: '001', tag: null, final_price_high: 100000, source_shop_name: 'KECAK',
          override_reason: null, backfilled: true },
      ]);
    }
    throw new Error(`Unexpected table ${table}`);
  };
  try {
    const response = await galleryRoutes.request(`/gallery/price-history?q=${encodeURIComponent(' ピカチュウ ')}`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json() as { entries: any[]; truncated: boolean };
    assert.equal(body.truncated, false);
    assert.deepEqual(body.entries.map(entry => [entry.kind, entry.id]), [['regular', 'new'], ['custom', 'log2'], ['custom', 'log1'], ['regular', 'old']]);
    assert.equal(body.entries[0].pricing.comparison.high.store, 'シンソク郵送買取');
    assert.deepEqual(body.entries[0].pricing.comparison.rows.map((row: any) => row.store), ['シンソク郵送買取', 'トレカバンク']);
    assert.deepEqual(body.entries[1].custom, { sheet_name: '週末特価', display_date: '2026-09-22', rendered_by: 'staff@example.com',
      sheet_created_by: 'owner@example.com', source_shop_name: 'KECAK', override_reason: '店頭調整', backfilled: false });
    assert.equal(body.entries[2].price_high, 100000);
    assert.equal(body.entries[2].custom.backfilled, true);
    assert.equal(body.entries[1].price_high, 99000);
    assert.ok(body.entries.every(entry => !('run_id' in entry) && !('source_shinsoku_id' in entry)));
  } finally { globalThis.fetch = saved; }
});
