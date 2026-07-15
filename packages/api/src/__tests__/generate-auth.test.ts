import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { redactGenerateClaimToken, runRoutes } from '../routes/runs.js';

const originalToken = process.env.ORDER_LIST_IMPORT_API_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  else process.env.ORDER_LIST_IMPORT_API_TOKEN = originalToken;
});

test('実行履歴レスポンスからgenerate claim tokenを除外する', () => {
  assert.deepEqual(redactGenerateClaimToken({
    id: 'run-1',
    generate_claimed_at: '2026-07-15T03:00:00.000Z',
    generate_claim_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }), {
    id: 'run-1',
    generate_claimed_at: '2026-07-15T03:00:00.000Z',
  });
});

test('画像生成POSTは認証設定がなければfail closedする', async () => {
  delete process.env.ORDER_LIST_IMPORT_API_TOKEN;
  const response = await runRoutes.request('/jobs/generate', { method: 'POST' });
  assert.equal(response.status, 503);
});

test('画像生成POSTは不正なBearer tokenを拒否する', async () => {
  process.env.ORDER_LIST_IMPORT_API_TOKEN = 'a'.repeat(32);
  const response = await runRoutes.request('/jobs/generate', {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token' },
  });
  assert.equal(response.status, 401);
});

test('認証後も不正なrun_idはDBアクセス前に拒否する', async () => {
  const token = 'a'.repeat(32);
  process.env.ORDER_LIST_IMPORT_API_TOKEN = token;
  const response = await runRoutes.request('/jobs/generate', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ run_id: 'not-a-uuid' }),
  });
  assert.equal(response.status, 400);
});
