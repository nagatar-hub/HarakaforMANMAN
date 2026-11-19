import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { APP_ID, REPO, REPO_ID, CERT_URL, verifyEnvelope, checkEvent, checkRun, receive, applyVerifiedSource } from './receive.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'haraka-receiver-test-'));
const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(scratch, 'key.pem'),
  '-out', path.join(scratch, 'cert.pem'), '-subj', '/CN=receiver-unit-test', '-days', '1'], { stdio: 'ignore', windowsHide: true });
const key = fs.readFileSync(path.join(scratch, 'key.pem')), cert = fs.readFileSync(path.join(scratch, 'cert.pem'), 'utf8');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const now = Date.now(), base = 'a'.repeat(40), keyId = '1'.repeat(40), token = 'synthetic-test-token';
const wire = () => ({ version: 1, repo: REPO, action: 'probe', base, sha: base, commit: '', patch: '', issuedAt: Math.floor(now / 1000) });
const envelope = value => {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { payload, keyId, signature: sign('RSA-SHA256', Buffer.from('haraka-verified-source-v1\n' + payload), key).toString('base64') };
};
const certFetch = async (url, options) => {
  assert.equal(url, CERT_URL); assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined);
  return new Response(JSON.stringify({ [keyId]: cert }));
};
const event = () => ({ repository: { id: REPO_ID, full_name: REPO, default_branch: 'master' },
  sha: base, context: 'haraka/tokyo-source-verified', state: 'success', target_url: `https://github.com/${REPO}/runs/123` });
const run = value => ({ id: 123, name: 'Haraka Tokyo verified source', head_sha: base,
  app: { id: APP_ID, slug: 'google-cloud-build' }, status: 'completed', conclusion: 'success', output: { text: JSON.stringify(value) } });

test('fixed service-account certificate validates complete signed payload without any bearer token', async () => {
  assert.deepEqual(await verifyEnvelope(envelope(wire()), { now, fetchImpl: certFetch }), wire());
});
test('payload tampering, unknown signing key and signature confusion are rejected', async () => {
  const altered = envelope(wire()); altered.payload = Buffer.from(JSON.stringify({ ...wire(), base: 'b'.repeat(40) })).toString('base64url');
  await assert.rejects(verifyEnvelope(altered, { now, fetchImpl: certFetch }), /SIGNATURE_REJECTED/);
  await assert.rejects(verifyEnvelope({ ...envelope(wire()), keyId: '2'.repeat(40) }, { now, fetchImpl: certFetch }), /UNKNOWN_SIGNING_KEY/);
  await assert.rejects(verifyEnvelope({ ...envelope(wire()), signature: 'eA==' }, { now, fetchImpl: certFetch }), /SIGNATURE_REJECTED/);
});
test('stale/future signatures and alternate repo/probe content are rejected', async () => {
  for (const update of [{ issuedAt: wire().issuedAt - 3601 }, { issuedAt: wire().issuedAt + 61 },
    { repo: 'other/repository' }, { action: 'probe', patch: 'diff\n' }, { arbitrary: 'extra' }]) {
    await assert.rejects(verifyEnvelope(envelope({ ...wire(), ...update }), { now, fetchImpl: certFetch }));
  }
});
test('status cannot redirect API access or use another repository, App or check head', () => {
  assert.equal(checkEvent(event()), '123'); assert.deepEqual(checkRun(run(envelope(wire())), '123', event()), envelope(wire()));
  for (const change of [{ target_url: `https://github.com/${REPO}/runs/123?url=https://evil.test` },
    { repository: { ...event().repository, id: 1 } }, { context: 'haraka/tokyo-source-probe/123' }]) {
    assert.throws(() => checkEvent({ ...event(), ...change }));
  }
  for (const change of [{ app: { id: 1, slug: 'google-cloud-build' } }, { head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }]) {
    assert.throws(() => checkRun({ ...run(envelope(wire())), ...change }, '123', event()));
  }
});
test('probe receives only verified wire and writes a nonrecursive fixed success context', async () => {
  const requests = [], signed = envelope(wire()); let applied = false;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === CERT_URL) return certFetch(url, options);
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    if (url.endsWith('/check-runs/123')) return new Response(JSON.stringify(run(signed)));
    assert.equal(url, `https://api.github.com/repos/${REPO}/statuses/${base}`);
    assert.deepEqual(JSON.parse(options.body), { state: 'success', context: 'haraka/tokyo-source-probe/123', description: 'Verified receiver and receive-pack access' });
    return new Response('{}', { status: 201 });
  };
  await receive(event(), { token, now, fetchImpl, apply: async value => { applied = true; assert.deepEqual(value, wire()); return { action: 'probe' }; } });
  assert.equal(applied, true); assert.equal(requests.length, 3);
});

function sourceFixture(target = 'packages/job/src/lib/oripark-coverage.ts') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haraka-receive-'));
  const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
  git(['init', '--quiet']); fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
  fs.writeFileSync(path.join(root, target), 'export function fixture() { return 1; }\n');
  git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline']);
  const parent = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(root, target), 'export function fixture() { return 2; }\n');
  git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'candidate']);
  const sha = git(['rev-parse', 'HEAD']).trim(), commit = git(['cat-file', 'commit', sha]);
  const patch = git(['diff', '--binary', parent, sha]); git(['reset', '--hard', parent]);
  const value = { ...wire(), action: 'publish', base: parent, sha, commit, patch };
  let current = parent; const calls = [];
  const gitImpl = (args, _cwd, options) => {
    calls.push(args);
    if (args[0] === 'init' || args[0] === 'remote' || args[0] === 'fetch') return '';
    if (args[0] === 'ls-remote') return `${current}\trefs/heads/master\n`;
    if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') return parent + '\n';
    if (args[0] === 'push') {
      assert.equal(options.token, token); assert.equal(args.some(arg => arg.startsWith('--force')), false);
      if (!args.includes('--dry-run')) current = sha;
      return '';
    }
    return git(args, options);
  };
  return { root, value, gitImpl, calls, setHead: head => { current = head; } };
}
test('real git apply/index/tree/hash validation permits only the signed fast-forward and never checks out candidate', () => {
  const f = sourceFixture();
  assert.deepEqual(applyVerifiedSource(f.value, { root: f.root, token, gitImpl: f.gitImpl }), { action: 'publish', sha: f.value.sha });
  assert.deepEqual(f.calls.filter(args => args[0] === 'checkout'), [['checkout', '--detach', '--quiet', f.value.base]]);
  assert.deepEqual(f.calls.find(args => args[0] === 'push'), ['push', '--no-verify', '--porcelain', 'origin', `${f.value.sha}:refs/heads/master`]);
});
test('unapproved file, over-two-path change, tree/hash mismatch and moved master cannot push', () => {
  for (const variant of ['path', 'paths', 'tree', 'commit', 'head']) {
    const f = sourceFixture(variant === 'path' ? 'package.json' : undefined);
    if (variant === 'tree') f.value.patch = f.value.patch.replace('return 2;', 'return 3;');
    if (variant === 'commit') f.value.commit += '\n';
    if (variant === 'head') f.setHead('b'.repeat(40));
    if (variant === 'paths') {
      const original = f.gitImpl;
      f.gitImpl = (args, cwd, options) => args.join(' ') === 'diff --cached --name-only -z'
        ? ['packages/job/src/lib/oripark-coverage.ts', 'packages/job/src/lib/tokyo-normal-cards.ts',
          'packages/job/src/lib/haraka-card-images.ts'].join('\0') + '\0' : original(args, cwd, options);
    }
    assert.throws(() => applyVerifiedSource(f.value, { root: f.root, token, gitImpl: f.gitImpl }));
    assert.equal(f.calls.some(args => args[0] === 'push'), false);
  }
});
test('already applied source is idempotent and probe only uses dry-run receive-pack', () => {
  const applied = sourceFixture(); applied.setHead(applied.value.sha);
  applyVerifiedSource(applied.value, { root: applied.root, token, gitImpl: applied.gitImpl });
  assert.equal(applied.calls.some(args => args[0] === 'push'), false);
  const probe = sourceFixture(); probe.value = { ...probe.value, action: 'probe', sha: probe.value.base, commit: '', patch: '' };
  applyVerifiedSource(probe.value, { root: probe.root, token, gitImpl: probe.gitImpl });
  assert.equal(probe.calls.filter(args => args[0] === 'push').length, 1);
  assert.equal(probe.calls.find(args => args[0] === 'push').includes('--dry-run'), true);
});
