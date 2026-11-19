import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expectedRepo, github } from './cloud.mjs';
import { encodeRelayPayload, relaySource, RELAY_REPO, RELAY_CHECK, RELAY_CONTEXT, RELAY_SIGNING_PREFIX } from './relay.mjs';

const now = 1800000000000, base = 'a'.repeat(40), checkId = 123456;
const commit = `tree ${'b'.repeat(40)}\nparent ${base}\nauthor Haraka Tokyo Repair <haraka-tokyo-repair@tomstocks.net> 1800000001 +0000\ncommitter Haraka Tokyo Repair <haraka-tokyo-repair@tomstocks.net> 1800000001 +0000\n\nfix(tokyo): verified fixture\n`;
const sha = createHash('sha1').update(`commit ${Buffer.byteLength(commit)}\0`).update(commit).digest('hex');
const patch = 'diff --git a/packages/job/src/lib/tokyo-normal-cards.ts b/packages/job/src/lib/tokyo-normal-cards.ts\nfixture\n';
const request = { action: 'publish', base, sha, commit, patch };
const probe = { action: 'probe', base, sha: base, commit: '', patch: '' };
const wire = extra => ({ version: 1, repo: RELAY_REPO, ...request, issuedAt: now / 1000, ...extra });
const token = 'fixture-checks-token-never-published';
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });

function mock(action = 'publish') {
  const state = { head: base, calls: [], googleCalls: [], trigger: false, statuses: null, signed: null };
  const options = {
    now: () => now, maxPolls: 2, pollMs: 0, sleep: async () => {}, readHead: async () => state.head,
    google: async (url, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      state.googleCalls.push({ url, body });
      if (url.endsWith(':signBlob')) {
        state.signed = body.payload;
        return response({ keyId: 'a1'.repeat(20), signedBlob: Buffer.alloc(256, 7).toString('base64') });
      }
      if (url.endsWith('/repositories')) return response({ repositories: [{ name: expectedRepo, remoteUri: github }] });
      if (url.endsWith(':accessReadWriteToken')) return response({ token, expirationTime: new Date(now + 3600000).toISOString() });
      assert.fail('Unexpected Google request');
    },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      state.calls.push({ url, body, headers: init.headers });
      if (url.endsWith('/check-runs')) return response({ id: checkId, ...body });
      if (url.endsWith(`/statuses/${base}`)) {
        state.trigger = true;
        if (action !== 'probe') state.head = sha;
        return response({ id: 999 });
      }
      if (url.includes('/statuses?')) return response(state.statuses ?? [{
        context: `haraka/tokyo-source-${action}/${checkId}`, state: 'success', creator: { login: 'github-actions[bot]', type: 'Bot' },
      }]);
      assert.fail('Unexpected GitHub request');
    },
  };
  return { state, options };
}

test('wire encoding preserves raw commit and rejects unverified extra fields/hash changes', () => {
  const encoded = encodeRelayPayload(wire());
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64url')), wire());
  assert.throws(() => encodeRelayPayload(wire({ diagnostic: 'not allowed' })), /INVALID_PAYLOAD/);
  assert.throws(() => encodeRelayPayload(wire({ commit: commit.replace('fixture', 'changed') })), /COMMIT_MISMATCH/);
  assert.throws(() => encodeRelayPayload(wire({ commit: commit.trimEnd() })), /INVALID_PATCH/);
  assert.throws(() => encodeRelayPayload(wire({ patch: patch + 'x'.repeat(32768) + '\n' })), /TOO_LARGE/);
  assert.throws(() => encodeRelayPayload(wire({ ...probe, patch })), /INVALID_PROBE/);
});

test('sender signs exact source bytes and exposes no OAuth credential in check/status payloads', async () => {
  const { state, options } = mock();
  assert.deepEqual(await relaySource(request, options), { sha, checkId });
  const check = state.calls[0].body, envelope = JSON.parse(check.output.text);
  assert.deepEqual(Object.keys(envelope).sort(), ['keyId', 'payload', 'signature']);
  assert.equal(Buffer.from(state.signed, 'base64').toString(), RELAY_SIGNING_PREFIX + envelope.payload);
  assert.deepEqual(JSON.parse(Buffer.from(envelope.payload, 'base64url')), wire());
  assert.equal(check.name, RELAY_CHECK); assert.equal(check.head_sha, base); assert.equal(check.conclusion, 'success');
  assert.equal(check.status, 'completed'); assert.equal(check.output.text.startsWith('```'), false);
  assert.equal(JSON.stringify(state.calls.map(call => call.body)).includes(token), false);
  assert.equal(state.calls[1].body.context, RELAY_CONTEXT);
  assert.equal(state.calls[1].body.target_url, `https://github.com/${RELAY_REPO}/runs/${checkId}`);
  assert.ok(state.calls.every(call => call.headers.Authorization === `Bearer ${token}`));
});

test('probe requires matching GitHub Actions bot status and keeps master unchanged', async () => {
  const { state, options } = mock('probe');
  assert.deepEqual(await relaySource(probe, options), { sha: base, checkId, probe: true });
  assert.equal(state.head, base); assert.equal(state.trigger, true);
});

test('same-context success from another creator is ignored', async () => {
  const { state, options } = mock('probe');
  state.statuses = [{ context: `haraka/tokyo-source-probe/${checkId}`, state: 'success', creator: { login: 'another-bot', type: 'Bot' } }];
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_TIMEOUT' && error.expectedSha === base && error.checkRunId === checkId);
});

test('receiver failure is rejected without resending the trigger', async () => {
  const { state, options } = mock('probe');
  state.statuses = [{ context: `haraka/tokyo-source-probe/${checkId}`, state: 'failure', creator: { login: 'github-actions[bot]', type: 'Bot' } }];
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_RECEIVER_REJECTED');
  assert.equal(state.calls.filter(call => call.body?.context === RELAY_CONTEXT).length, 1);
});

test('unknown trigger result can be reconciled by the expected public HEAD', async () => {
  const { state, options } = mock(), fetch = options.fetch;
  options.fetch = async (url, init) => {
    const result = await fetch(url, init);
    if (url.endsWith(`/statuses/${base}`)) throw new Error('network outcome unknown');
    return result;
  };
  assert.deepEqual(await relaySource(request, options), { sha, checkId });
  assert.equal(state.calls.filter(call => call.body?.context === RELAY_CONTEXT).length, 1);
});

test('unknown trigger result times out with identity and never retries the POST', async () => {
  const { state, options } = mock('probe'), fetch = options.fetch;
  state.statuses = [];
  options.fetch = async (url, init) => {
    const result = await fetch(url, init);
    return url.endsWith(`/statuses/${base}`) ? response({}, 503) : result;
  };
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_TIMEOUT' && error.checkRunId === checkId && error.expectedSha === base);
  assert.equal(state.calls.filter(call => call.body?.context === RELAY_CONTEXT).length, 1);
});

test('definite trigger permission rejection retains phase and HTTP status', async () => {
  const { options } = mock('probe'), fetch = options.fetch;
  options.fetch = async (url, init) => url.endsWith(`/statuses/${base}`) ? response({}, 403) : fetch(url, init);
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_TRIGGER_HTTP_403' && error.phase === 'TRIGGER' && error.status === 403);
});

test('check creation rejection is distinguishable and does not send trigger', async () => {
  const { state, options } = mock('probe');
  options.fetch = async () => response({}, 422);
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_CHECK_HTTP_422' && error.phase === 'CHECK');
  assert.equal(state.trigger, false);
});

test('status readback permission failure is uncertain after trigger', async () => {
  const { options } = mock('probe'), fetch = options.fetch;
  options.fetch = async (url, init) => url.includes('/statuses?') ? response({}, 403) : fetch(url, init);
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_TIMEOUT' && error.phase === 'STATUS' && error.status === 403 && error.expectedSha === base);
});

test('head readback transport failure preserves uncertain publication identity', async () => {
  const { state, options } = mock('probe');
  options.readHead = async () => { if (state.trigger) throw new Error('read unavailable'); return base; };
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_TIMEOUT' && error.expectedSha === base && error.checkRunId === checkId);
});

test('dedicated connection must contain exactly the fixed repository before requesting token', async () => {
  const { state, options } = mock(), google = options.google;
  options.google = async (url, init) => url.endsWith('/repositories')
    ? response({ repositories: [{ name: expectedRepo, remoteUri: github }, { name: 'another', remoteUri: 'other' }] }) : google(url, init);
  await assert.rejects(relaySource(request, options), error => error.code === 'SOURCE_CONNECTION_SCOPE_CHANGED');
  assert.equal(state.googleCalls.some(call => call.url.endsWith(':accessReadWriteToken')), false);
  assert.equal(state.calls.length, 0);
});

test('fixed project numeric alias is accepted but another project is rejected', async () => {
  const { options } = mock(), google = options.google;
  options.google = async (url, init) => url.endsWith('/repositories')
    ? response({ repositories: [{ name: expectedRepo.replace('spectre-tomstocks-20260227', '569936489397'), remoteUri: github }] }) : google(url, init);
  assert.equal((await relaySource(request, options)).sha, sha);
  options.google = async (url, init) => url.endsWith('/repositories')
    ? response({ repositories: [{ name: expectedRepo.replace('spectre-tomstocks-20260227', '123456789000'), remoteUri: github }] }) : google(url, init);
  await assert.rejects(relaySource(request, options), error => error.code === 'SOURCE_CONNECTION_SCOPE_CHANGED');
});

test('already applied immutable SHA produces no new check or trigger', async () => {
  const { state, options } = mock(); state.head = sha;
  assert.deepEqual(await relaySource(request, options), { sha, alreadyPublished: true });
  assert.equal(state.calls.length, 0);
});

test('concurrent master advance is never overwritten', async () => {
  const { state, options } = mock('probe'), fetch = options.fetch;
  options.fetch = async (url, init) => {
    const result = await fetch(url, init);
    if (url.endsWith(`/statuses/${base}`)) state.head = 'f'.repeat(40);
    return result;
  };
  await assert.rejects(relaySource(probe, options), error => error.code === 'SOURCE_RELAY_BASE_CHANGED');
  assert.equal(state.head, 'f'.repeat(40));
});
