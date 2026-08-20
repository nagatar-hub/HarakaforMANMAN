import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createSupabaseApiKeyFetch } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';

const originalUrl = process.env.SUPABASE_URL;
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

test('new Supabase API keys are never sent as their Authorization bearer', async () => {
  for (const apiKey of [
    'sb_secret_test_only_not_a_real_key',
    'sb_publishable_test_only_not_a_real_key',
  ]) {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = apiKey;
    const capturedRequests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedRequests.push(new Request(input, init));
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const { error } = await createSupabaseClient(fetchImpl).from('db_card').select('id');

    assert.equal(error, null);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0].headers.get('apikey'), apiKey);
    assert.equal(capturedRequests[0].headers.has('Authorization'), false);
  }
});

test('filtering preserves an independent user bearer token', async () => {
  const apiKey = 'sb_secret_test_only_not_a_real_key';
  const capturedRequests: Request[] = [];
  const safeFetch = createSupabaseApiKeyFetch(apiKey, async (input, init) => {
    capturedRequests.push(new Request(input, init));
    return new Response(null, { status: 204 });
  });

  await safeFetch('https://example.supabase.co/rest/v1/cards', {
    headers: { apikey: apiKey, Authorization: 'Bearer independent-user-token' },
  });

  assert.equal(capturedRequests[0].headers.get('Authorization'), 'Bearer independent-user-token');
});

test('legacy JWT API-key bearer behavior is unchanged', async () => {
  const legacyKey = 'legacy.jwt.test-only';
  const capturedRequests: Request[] = [];
  const safeFetch = createSupabaseApiKeyFetch(legacyKey, async (input, init) => {
    capturedRequests.push(new Request(input, init));
    return new Response(null, { status: 204 });
  });

  await safeFetch('https://example.supabase.co/rest/v1/cards', {
    headers: { apikey: legacyKey, Authorization: `Bearer ${legacyKey}` },
  });

  assert.equal(capturedRequests[0].headers.get('Authorization'), `Bearer ${legacyKey}`);
});
