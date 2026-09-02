import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimGenerateRun,
  createSupabaseGenerateRunClaimStore,
  GENERATE_CLAIM_LEASE_MS,
  GenerateRunClaimError,
  parseGenerateRunRequest,
  type GenerateRunClaimStore,
} from '../lib/generate-run-claim.js';

function createRecordingSupabase(maybeData: unknown = null) {
  const maybeDataSequence = Array.isArray(maybeData) ? [...maybeData] : null;
  const calls: Array<[string, ...unknown[]]> = [];
  const query: Record<string, (...args: unknown[]) => unknown> & {
    then?: (resolve: (value: { error: null }) => unknown, reject: (reason: unknown) => unknown) => unknown;
  } = {};
  for (const method of ['update', 'eq', 'is', 'not', 'lt', 'select', 'order', 'limit']) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  query.maybeSingle = async () => {
    calls.push(['maybeSingle']);
    return { data: maybeDataSequence ? (maybeDataSequence.shift() ?? null) : maybeData, error: null };
  };
  query.then = (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject);

  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return query;
    },
  } as unknown as Parameters<typeof createSupabaseGenerateRunClaimStore>[0];
  return { calls, client };
}

function createStore(ids: string[]): GenerateRunClaimStore {
  const eligible = new Set(ids);
  return {
    async recoverStaleUnstarted() {},
    async claimEligible(id, claimedAtIso, claimToken) {
      if (!eligible.delete(id)) return null;
      return {
        id,
        status: 'running',
        generate_claimed_at: claimedAtIso,
        generate_claim_token: claimToken,
      };
    },
    async releaseUnstarted(id) {
      eligible.add(id);
      return true;
    },
  };
}

test('画像生成リクエストはUUIDのrun_idだけを受け付ける', () => {
  assert.deepEqual(parseGenerateRunRequest({}), { ok: false, error: 'run_idを指定してください' });
  assert.deepEqual(
    parseGenerateRunRequest({ run_id: 'FC6B20A5-73F7-472A-B704-9D1FEF750C35' }),
    { ok: true, runId: 'fc6b20a5-73f7-472a-b704-9d1fef750c35' },
  );
  const invalid = parseGenerateRunRequest({ run_id: '../latest' });
  assert.equal(invalid.ok, false);
});

test('明示run_idだけをclaimし、過去Runの自動選択はしない', async () => {
  const explicitStore = createStore(['10000000-0000-4000-8000-000000000001']);
  const explicit = await claimGenerateRun(
    explicitStore,
    '10000000-0000-4000-8000-000000000001',
  );
  assert.equal(explicit.id, '10000000-0000-4000-8000-000000000001');

  await assert.rejects(
    claimGenerateRun(createStore(['20000000-0000-4000-8000-000000000002']), null),
    /過去のRunは自動選択しません/,
  );
});

test('同じrun_idの二重claimは片方だけ成功する', async () => {
  const id = '30000000-0000-4000-8000-000000000003';
  const store = createStore([id]);
  await claimGenerateRun(store, id);
  await assert.rejects(
    claimGenerateRun(store, id),
    (error: unknown) => error instanceof GenerateRunClaimError && error.status === 409,
  );
});

test('claim token factoryがUUID以外を返した場合はclaimしない', async () => {
  const store = createStore(['30000000-0000-4000-8000-000000000004']);
  await assert.rejects(
    claimGenerateRun(store, '30000000-0000-4000-8000-000000000004', new Date(), () => 'not-a-uuid'),
    /claim tokenのUUID生成に失敗しました/,
  );
});

test('画像生成待ちRunがなければ404になる', async () => {
  await assert.rejects(
    claimGenerateRun(createStore([]), null),
    (error: unknown) => error instanceof GenerateRunClaimError && error.status === 404,
  );
});

test('claim前に75分超の未着手claimを回復し、claim時刻を保存する', async () => {
  const id = '40000000-0000-4000-8000-000000000004';
  const claimToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const now = new Date('2026-07-15T03:00:00.000Z');
  const calls: string[] = [];
  const store: GenerateRunClaimStore = {
    async recoverStaleUnstarted(staleBeforeIso) {
      calls.push('recover:' + staleBeforeIso);
    },
    async claimEligible(claimId, claimedAtIso, receivedToken) {
      calls.push('claim:' + claimedAtIso + ':' + receivedToken);
      return {
        id: claimId,
        status: 'running',
        generate_claimed_at: claimedAtIso,
        generate_claim_token: receivedToken,
      };
    },
    async releaseUnstarted() {
      return true;
    },
  };

  const claimed = await claimGenerateRun(store, id, now, () => claimToken);
  assert.equal(claimed.generate_claimed_at, now.toISOString());
  assert.equal(claimed.generate_claim_token, claimToken);
  assert.deepEqual(calls, [
    'recover:' + new Date(now.getTime() - GENERATE_CLAIM_LEASE_MS).toISOString(),
    'claim:' + now.toISOString() + ':' + claimToken,
  ]);
});

test('Supabase storeは期限切れ回復とreleaseを未着手かつ同一leaseに限定する', async () => {
  const runId = '50000000-0000-4000-8000-000000000005';
  const claimedAt = '2026-07-15T03:00:00.000Z';
  const claimToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const staleBefore = '2026-07-15T01:45:00.000Z';

  const claim = createRecordingSupabase({
    id: runId,
    status: 'running',
    generate_claimed_at: claimedAt,
    generate_claim_token: claimToken,
  });
  const claimed = await createSupabaseGenerateRunClaimStore(claim.client, 'manman')
    .claimEligible(runId, claimedAt, claimToken);
  assert.equal(claimed?.generate_claim_token, claimToken);
  assert.deepEqual(claim.calls, [
    ['from', 'order_list_import'],
    ['select', 'id'],
    ['eq', 'store', 'manman'],
    ['order', 'business_date', { ascending: false }],
    ['order', 'created_at', { ascending: false }],
    ['limit', 1],
    ['maybeSingle'],
    ['from', 'run'],
    ['select', 'id'],
    ['eq', 'store', 'manman'],
    ['eq', 'order_list_import_id', runId],
    ['order', 'started_at', { ascending: false }],
    ['limit', 1],
    ['maybeSingle'],
    ['from', 'run'],
    ['update', {
      status: 'running',
      error_message: null,
      generate_claimed_at: claimedAt,
      generate_claim_token: claimToken,
    }],
    ['eq', 'id', runId],
    ['eq', 'store', 'manman'],
    ['eq', 'order_list_import_id', runId],
    ['eq', 'status', 'completed'],
    ['not', 'plan_done_at', 'is', null],
    ['is', 'generate_done_at', null],
    ['select', 'id, status, generate_claimed_at, generate_claim_token'],
    ['maybeSingle'],
  ]);

  const recovery = createRecordingSupabase();
  await createSupabaseGenerateRunClaimStore(recovery.client, 'manman').recoverStaleUnstarted(staleBefore);
  assert.deepEqual(recovery.calls, [
    ['from', 'run'],
    ['update', {
      status: 'completed',
      generate_claimed_at: null,
      generate_claim_token: null,
    }],
    ['eq', 'store', 'manman'],
    ['eq', 'status', 'running'],
    ['is', 'generate_done_at', null],
    ['is', 'postal_done_at', null],
    ['is', 'store_done_at', null],
    ['not', 'generate_claimed_at', 'is', null],
    ['lt', 'generate_claimed_at', staleBefore],
  ]);

  const release = createRecordingSupabase({ id: runId });
  const released = await createSupabaseGenerateRunClaimStore(release.client, 'manman')
    .releaseUnstarted(runId, claimToken, claimedAt);
  assert.equal(released, true);
  assert.deepEqual(release.calls, [
    ['from', 'run'],
    ['update', {
      status: 'completed',
      generate_claimed_at: null,
      generate_claim_token: null,
    }],
    ['eq', 'id', runId],
    ['eq', 'store', 'manman'],
    ['eq', 'status', 'running'],
    ['eq', 'generate_claim_token', claimToken],
    ['eq', 'generate_claimed_at', claimedAt],
    ['is', 'generate_done_at', null],
    ['is', 'postal_done_at', null],
    ['is', 'store_done_at', null],
    ['select', 'id'],
    ['maybeSingle'],
  ]);
});

test('Supabase storeは最新取込内の古いRunをclaimしない', async () => {
  const oldRunId = '60000000-0000-4000-8000-000000000006';
  const latestRunId = '70000000-0000-4000-8000-000000000007';
  const db = createRecordingSupabase([{ id: 'latest-import' }, { id: latestRunId }]);

  const claimed = await createSupabaseGenerateRunClaimStore(db.client, 'manman')
    .claimEligible(oldRunId, '2026-07-15T03:00:00.000Z', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

  assert.equal(claimed, null);
  assert.equal(db.calls.some(([method]) => method === 'update'), false);
});
