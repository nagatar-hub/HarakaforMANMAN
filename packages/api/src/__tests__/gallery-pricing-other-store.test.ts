import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.STORE_NAME = 'manman';
process.env.ORDER_LIST_IMPORT_API_TOKEN = 't'.repeat(32);
process.env.SUPABASE_URL = 'https://gallery-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
test('non-Tokyo gallery has identical response and no pricing queries even when authorized', async () => {
  const { galleryRoutes } = await import('../routes/gallery.js');
  const saved = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const table = url.pathname.split('/').at(-1);
    assert.ok(['run', 'prepared_card', 'generated_page'].includes(table!));
    if (table === 'run') assert.equal(url.searchParams.get('store'), 'eq.manman');
    const data = table === 'generated_page' ? { id: 'page', run_id: 'run', card_ids: ['card'] }
      : table === 'run' ? (url.searchParams.get('id')?.startsWith('eq.') ? { id: 'run' } : [{ id: 'run' }])
        : [{ id: 'card', run_id: 'run', price_high: 100 }];
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await galleryRoutes.request('/gallery/pages/page', { headers: { Authorization: `Bearer ${'t'.repeat(32)}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { cards: unknown[] }).cards, [{ id: 'card', run_id: 'run', price_high: 100 }]);
  } finally { globalThis.fetch = saved; }
});
