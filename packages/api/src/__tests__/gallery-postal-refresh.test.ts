import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobsClient } from '@google-cloud/run';

process.env.STORE_NAME = 'manman-akihabara';
process.env.ORDER_LIST_IMPORT_API_TOKEN = 't'.repeat(32);
process.env.SUPABASE_URL = 'https://postal-refresh-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

const runId = '10000000-0000-4000-8000-000000000001';

test('postal refresh POST claims and launches the pinned job, then GET returns its progress', async () => {
  const savedFetch = globalThis.fetch;
  const savedRunJob = JobsClient.prototype.runJob;
  const cloudCalls: any[] = [];
  const restCalls: Array<{ url: URL; init?: RequestInit }> = [];
  (JobsClient.prototype as any).runJob = async (request: unknown) => {
    cloudCalls.push(request);
    return [{ name: 'operations/postal-refresh', metadata: { name: 'executions/postal-refresh' } }];
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.host, 'postal-refresh-test.invalid');
    restCalls.push({ url, init });
    let data: unknown;
    if (url.pathname === '/rest/v1/run') {
      assert.equal(url.searchParams.get('id'), `eq.${runId}`);
      assert.equal(url.searchParams.get('store'), 'eq.manman-akihabara');
      data = { id: runId };
    } else if (url.pathname === '/rest/v1/rpc/claim_tokyo_peleka_postal_refresh') {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.p_run_id, runId);
      assert.match(body.p_request_id, /^[0-9a-f-]{36}$/u);
      data = null;
    } else if (url.pathname === '/rest/v1/tokyo_peleka_postal_refresh') {
      data = { run_id: runId, request_id: 'request-current', status: 'running' };
    } else throw new Error(`Unexpected request ${url}`);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const { galleryRoutes } = await import('../routes/gallery.js');
    const started = await galleryRoutes.request(`/gallery/runs/${runId}/postal/refresh`, { method: 'POST' });
    assert.equal(started.status, 202);
    const startPayload = await started.json() as { requestId: string; status: string };
    assert.equal(startPayload.status, 'running');
    assert.match(startPayload.requestId, /^[0-9a-f-]{36}$/u);
    assert.equal(cloudCalls.length, 1);
    const env = Object.fromEntries(cloudCalls[0].overrides.containerOverrides[0].env
      .map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    assert.deepEqual(env, {
      JOB_NAME: 'refresh-peleka-postal', STORE_NAME: 'manman-akihabara', RUN_ID: runId,
      POSTAL_REFRESH_REQUEST_ID: startPayload.requestId, TRIGGER: 'web-ui',
    });

    const progress = await galleryRoutes.request(`/gallery/runs/${runId}/postal/refresh`, {
      headers: { Authorization: `Bearer ${'t'.repeat(32)}` },
    });
    assert.equal(progress.status, 200);
    assert.deepEqual(await progress.json(), {
      run_id: runId, request_id: 'request-current', status: 'running',
    });
    assert.ok(restCalls.some(call => call.url.pathname.endsWith('/rpc/claim_tokyo_peleka_postal_refresh')));
  } finally {
    globalThis.fetch = savedFetch;
    JobsClient.prototype.runJob = savedRunJob;
  }
});
