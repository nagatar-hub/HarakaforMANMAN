import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOperatorAuditEntry, persistOperatorAudit } from '../lib/operator-audit.js';
import { authorizeInternalMutationRequest } from '../lib/internal-api-auth.js';

test('operator audit keeps only mutation metadata and removes query values', () => {
  const entry = buildOperatorAuditEntry({
    store: 'manman-akihabara',
    actorEmail: 'Operator@TomStocks.net',
    method: 'PATCH',
    url: 'https://api.example/api/order-list/imports/550e8400-e29b-41d4-a716-446655440000/confirm?token=secret',
    statusCode: 200,
    now: () => '2026-09-03T00:00:00.000Z',
  });

  assert.deepEqual(entry, {
    store: 'manman-akihabara',
    actor_email: 'operator@tomstocks.net',
    http_method: 'PATCH',
    request_path: '/api/order-list/imports/550e8400-e29b-41d4-a716-446655440000/confirm',
    target_id: '550e8400-e29b-41d4-a716-446655440000',
    status_code: 200,
    created_at: '2026-09-03T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(entry).includes('secret'), false);
});

test('operator audit ignores reads and requests without a valid actor email', () => {
  const base = {
    store: 'manman-akihabara',
    actorEmail: 'operator@tomstocks.net',
    url: 'https://api.example/api/runs',
    statusCode: 200,
  };
  assert.equal(buildOperatorAuditEntry({ ...base, method: 'GET' }), null);
  assert.equal(buildOperatorAuditEntry({ ...base, method: 'POST', actorEmail: undefined }), null);
});

test('HTTP mutations require the internal bearer and non-Osaka operator identity', () => {
  const token = 'a'.repeat(32);
  assert.equal(authorizeInternalMutationRequest('GET', undefined, token), 'not_required');
  assert.equal(authorizeInternalMutationRequest('POST', undefined, token), 'unauthorized');
  assert.equal(authorizeInternalMutationRequest('PATCH', 'Bearer wrong', token), 'unauthorized');
  assert.equal(authorizeInternalMutationRequest('DELETE', `Bearer ${token}`, token), 'operator_required');
  assert.equal(authorizeInternalMutationRequest(
    'DELETE', `Bearer ${token}`, token, ' Staff@TomStocks.net ',
  ), 'authorized');
  assert.equal(authorizeInternalMutationRequest(
    'PATCH', `Bearer ${token}`, token, 'staff@@tomstocks.net',
  ), 'operator_required');
  assert.equal(authorizeInternalMutationRequest(
    'POST', `Bearer ${token}`, token, undefined, 'manman',
  ), 'authorized');
  assert.equal(authorizeInternalMutationRequest(
    'POST', `Bearer ${token}`, token, undefined, 'manman-akihabara',
  ), 'operator_required');
  assert.equal(authorizeInternalMutationRequest('PUT', undefined, undefined), 'misconfigured');
});

test('a state-bound OAuth callback can explicitly audit its GET mutation', () => {
  const entry = buildOperatorAuditEntry({
    store: 'manman-akihabara',
    actorEmail: 'operator@tomstocks.net',
    method: 'GET',
    url: 'https://api.example/api/x/oauth/callback?code=secret',
    statusCode: 302,
    targetId: '1234567890',
    auditReadMutation: true,
  });
  assert.equal(entry?.request_path, '/api/x/oauth/callback');
  assert.equal(entry?.target_id, '1234567890');
  assert.equal(JSON.stringify(entry).includes('secret'), false);
});

test('audit persistence failure falls back to structured stderr without failing the operation', async () => {
  const entry = buildOperatorAuditEntry({
    store: 'manman-akihabara',
    actorEmail: 'operator@tomstocks.net',
    method: 'POST',
    url: 'https://api.example/api/jobs/generate',
    statusCode: 202,
    targetId: '550e8400-e29b-41d4-a716-446655440000',
    now: () => '2026-09-03T00:00:00.000Z',
  });
  assert.ok(entry);
  const messages: string[] = [];
  const original = console.error;
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    await assert.doesNotReject(persistOperatorAudit(entry, async () => { throw new Error('db unavailable'); }));
  } finally {
    console.error = original;
  }
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), {
    event: 'operator_audit',
    persistence: 'stderr',
    ...entry,
  });
});
