import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { git } from './worker.mjs';
import { github } from './cloud.mjs';
import { applyProposal } from './policy.mjs';
import { encodeRelayPayload } from './relay.mjs';
import { sourceHead, checkSourceAccess, assertDeployedSource, publish, rollbackSource } from './source.mjs';

const author = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_AUTHOR_DATE: '1800000000 +0000', GIT_COMMITTER_DATE: '1800000000 +0000' };
const file = 'packages/job/src/lib/tokyo-normal-cards.ts';
function inputGit(args, cwd, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(result.status, 0, 'local git input operation'); return result.stdout.trim();
}
function environment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haraka-source-test-'));
  const seed = path.join(root, 'seed'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(seed); git(['init', '--quiet', '--initial-branch=master'], seed); git(['init', '--quiet', '--bare', remote], root);
  fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
  fs.writeFileSync(path.join(seed, file), "export function resolveTokyoProductTag() { return 'OLD'; }\n");
  git(['add', '--', file], seed); git(['commit', '--quiet', '-m', 'fixture base'], seed, author);
  git(['remote', 'add', 'origin', remote], seed); git(['push', '--quiet', 'origin', 'master'], seed);
  const base = git(['rev-parse', 'HEAD'], seed);
  const proposal = { base, stage: 'sync', decision: 'repair', edits: [{ path: file, before: "return 'OLD';", after: "return 'NEW';" }] };
  applyProposal(seed, 'sync', proposal); git(['add', '--', file], seed);
  const verified = { base, stage: 'sync', files: [file], tree: git(['write-tree'], seed) };
  const spec = { attempt: 'e7f5dd21-cd48-4e67-bf10-8a6dd25408b5', base, stage: 'sync', proposal, verified };
  const calls = { requests: [], probes: 0 };
  const checkoutLocal = (dir, sha) => {
    git(['init', '--quiet'], dir); git(['remote', 'add', 'origin', remote], dir);
    git(['fetch', '--quiet', '--depth=1', 'origin', sha], dir); git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
  };
  const d = {
    checkout: checkoutLocal,
    git(args, cwd, env) {
      assert.notEqual(args[0], 'push', 'sender must not push directly');
      if (args[0] === 'ls-remote') args = args.map(arg => arg === github ? remote : arg);
      return git(args, cwd, env);
    },
    async relaySource(request) {
      calls.requests.push(request);
      encodeRelayPayload({ version: 1, repo: 'nagatar-hub/HarakaforMANMAN', ...request, issuedAt: 1800000000 });
      const receiver = path.join(root, 'receiver-' + calls.requests.length); fs.mkdirSync(receiver); checkoutLocal(receiver, request.base);
      if (request.action === 'probe') {
        calls.probes++; git(['push', '--dry-run', '--quiet', 'origin', `${request.base}:refs/heads/master`], receiver);
        return { sha: request.sha, probe: true };
      }
      inputGit(['apply', '--index', '--binary', '-'], receiver, request.patch);
      const tree = git(['write-tree'], receiver);
      assert.equal(request.commit.split('\n')[0], `tree ${tree}`);
      assert.equal(inputGit(['hash-object', '-t', 'commit', '-w', '--stdin'], receiver, request.commit), request.sha);
      git(['push', '--quiet', 'origin', `${request.sha}:refs/heads/master`], receiver);
      return { sha: request.sha, checkId: calls.requests.length };
    },
  };
  return { root, seed, remote, spec, d, calls, cleanup() {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('verified raw tree and commit relay once, and restart returns the identical SHA', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d);
    assert.equal(await sourceHead(e.d), sha); assert.equal(await publish(e.spec, e.d), sha); assert.equal(e.calls.requests.length, 1);
    const wire = e.calls.requests[0]; assert.equal(wire.action, 'publish'); assert.ok(wire.commit.endsWith('\n')); assert.ok(wire.patch.endsWith('\n'));
    assert.equal(Object.hasOwn(wire, 'diagnostic'), false); assert.equal(Object.hasOwn(wire, 'incident'), false);
    git(['fetch', '--quiet', 'origin', sha], e.seed);
    assert.equal(git(['rev-parse', `${sha}^{tree}`], e.seed), e.spec.verified.tree);
  } finally { e.cleanup(); }
});
test('rollback relays a compensating child and is deterministic on restart', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d), reverted = await rollbackSource({ base: e.spec.base, sha }, e.d);
    assert.notEqual(reverted, e.spec.base); assert.equal(await rollbackSource({ base: e.spec.base, sha }, e.d), reverted);
    assert.equal(e.calls.requests.length, 2); assert.equal(e.calls.requests[1].action, 'rollback'); assert.equal(e.calls.requests[1].base, sha);
    git(['fetch', '--quiet', 'origin', reverted], e.seed);
    assert.equal(git(['rev-parse', `${reverted}^{tree}`], e.seed), git(['rev-parse', `${e.spec.base}^{tree}`], e.seed));
  } finally { e.cleanup(); }
});
test('unverified tree/files are rejected before sending anything', async () => {
  const e = environment();
  try {
    await assert.rejects(publish({ ...e.spec, verified: { ...e.spec.verified, tree: '0'.repeat(40) } }, e.d), /verified tree mismatch/);
    await assert.rejects(publish({ ...e.spec, verified: { ...e.spec.verified, files: [file, 'package.json'] } }, e.d), /verified files mismatch/);
    assert.equal(e.calls.requests.length, 0);
  } finally { e.cleanup(); }
});
test('runtime mismatch is rejected and compensated source is accepted', async () => {
  const e = environment();
  try {
    assert.equal(await assertDeployedSource(e.spec.base, e.spec.base, e.d), true);
    const sha = await publish(e.spec, e.d);
    await assert.rejects(assertDeployedSource(sha, e.spec.base, e.d), /runtime source differs/);
    const reverted = await rollbackSource({ base: e.spec.base, sha }, e.d);
    assert.equal(await assertDeployedSource(reverted, e.spec.base, e.d), true);
  } finally { e.cleanup(); }
});
test('rollback never overwrites another author advancing master', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d);
    git(['reset', '--hard', 'HEAD'], e.seed); git(['fetch', '--quiet', 'origin', sha], e.seed); git(['checkout', '--quiet', '--detach', sha], e.seed);
    fs.writeFileSync(path.join(e.seed, 'README.md'), 'Another author\n'); git(['add', 'README.md'], e.seed);
    git(['commit', '--quiet', '-m', 'concurrent change'], e.seed, author); git(['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], e.seed);
    await assert.rejects(rollbackSource({ base: e.spec.base, sha }, e.d), /master advanced/); assert.equal(e.calls.requests.length, 1);
  } finally { e.cleanup(); }
});
test('source readiness requires receiver probe acknowledgment and unchanged master', async () => {
  const e = environment();
  try {
    assert.equal(await checkSourceAccess(e.d), true); assert.equal(await sourceHead(e.d), e.spec.base); assert.equal(e.calls.probes, 1);
    e.d.relaySource = async () => ({ sha: e.spec.base });
    await assert.rejects(checkSourceAccess(e.d), /probe result missing/);
  } finally { e.cleanup(); }
});
test('publication acknowledgment loss is reconciled against actual branch HEAD', async () => {
  const e = environment();
  try {
    const receiver = e.d.relaySource;
    e.d.relaySource = async request => { await receiver(request); throw Object.assign(new Error('SOURCE_RELAY_TIMEOUT'), { code: 'SOURCE_RELAY_TIMEOUT', expectedSha: request.sha }); };
    const sha = await publish(e.spec, e.d); assert.equal(await sourceHead(e.d), sha); assert.equal(e.calls.requests.length, 1);
  } finally { e.cleanup(); }
});
