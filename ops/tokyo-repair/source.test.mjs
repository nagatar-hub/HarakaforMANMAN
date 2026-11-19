import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './worker.mjs';
import { github, expectedRepo } from './cloud.mjs';
import { applyProposal } from './policy.mjs';
import { sourceHead, checkSourceAccess, assertDeployedSource, publish, rollbackSource } from './source.mjs';

const author = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_AUTHOR_DATE: '1800000000 +0000', GIT_COMMITTER_DATE: '1800000000 +0000' };
const file = 'packages/job/src/lib/tokyo-normal-cards.ts';
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
  const calls = { writes: 0, tokens: 0, headers: [] };
  const d = {
    checkout(dir, sha) {
      git(['init', '--quiet'], dir); git(['remote', 'add', 'origin', remote], dir);
      git(['fetch', '--quiet', '--depth=1', 'origin', sha], dir); git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
    },
    git(args, cwd, env) {
      assert.equal(args.some(arg => arg.includes('fake-write-token')), false);
      if (args[0] === 'ls-remote') args = args.map(arg => arg === github ? remote : arg);
      if (args[0] === 'push') { calls.writes++; calls.headers.push({ ...env }); assert.equal(args.some(arg => arg.startsWith('--force')), false); }
      return git(args, cwd, env);
    },
    async google(url, init) {
      if (url.endsWith(':accessReadWriteToken')) {
        assert.equal(url, `https://cloudbuild.googleapis.com/v2/${expectedRepo}:accessReadWriteToken`);
        assert.equal(init.method, 'POST'); calls.tokens++;
        return { json: async () => ({ token: 'fake-write-token', expirationTime: new Date(Date.now() + 3600000).toISOString() }) };
      }
      assert.ok(url.endsWith('/repositories'));
      return { json: async () => ({ repositories: [{ name: expectedRepo, remoteUri: github }] }) };
    },
  };
  return { root, seed, remote, spec, d, calls, cleanup() {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('verified tree publishes once with deterministic commit and token only in transient env', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d);
    assert.equal(await sourceHead(e.d), sha);
    assert.equal(await publish(e.spec, e.d), sha);
    assert.equal(e.calls.writes, 1); assert.equal(e.calls.tokens, 1);
    assert.ok(e.calls.headers[0].GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));
    git(['fetch', '--quiet', 'origin', sha], e.seed);
    assert.equal(git(['rev-parse', `${sha}^{tree}`], e.seed), e.spec.verified.tree);
    assert.equal(git(['show', `${sha}:${file}`], e.seed), "export function resolveTokyoProductTag() { return 'NEW'; }");
  } finally { e.cleanup(); }
});
test('rollback is a deterministic forward commit, restores tree and is idempotent', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d);
    const reverted = await rollbackSource({ base: e.spec.base, sha }, e.d);
    assert.notEqual(reverted, e.spec.base); assert.equal(await sourceHead(e.d), reverted);
    assert.equal(await rollbackSource({ base: e.spec.base, sha }, e.d), reverted);
    assert.equal(e.calls.writes, 2);
    git(['fetch', '--quiet', 'origin', reverted], e.seed);
    assert.equal(git(['rev-parse', `${reverted}^{tree}`], e.seed), git(['rev-parse', `${e.spec.base}^{tree}`], e.seed));
    assert.equal(git(['cat-file', '-p', reverted], e.seed).split('\n')[1], `parent ${sha}`);
  } finally { e.cleanup(); }
});
test('changed verification metadata or tree is rejected before getting write credential', async () => {
  const e = environment();
  try {
    await assert.rejects(publish({ ...e.spec, verified: { ...e.spec.verified, tree: '0'.repeat(40) } }, e.d), /verified tree mismatch/);
    await assert.rejects(publish({ ...e.spec, verified: { ...e.spec.verified, files: [file, 'package.json'] } }, e.d), /verified files mismatch/);
    assert.equal(e.calls.tokens, 0); assert.equal(e.calls.writes, 0);
  } finally { e.cleanup(); }
});
test('runtime source mismatch is rejected while exact and compensated source are accepted', async () => {
  const e = environment();
  try {
    assert.equal(await assertDeployedSource(e.spec.base, e.spec.base, e.d), true);
    const sha = await publish(e.spec, e.d);
    await assert.rejects(assertDeployedSource(sha, e.spec.base, e.d), /runtime source differs/);
    const reverted = await rollbackSource({ base: e.spec.base, sha }, e.d);
    assert.equal(await assertDeployedSource(reverted, e.spec.base, e.d), true);
  } finally { e.cleanup(); }
});
test('rollback refuses another author advancing master and never rewrites history', async () => {
  const e = environment();
  try {
    const sha = await publish(e.spec, e.d);
    git(['reset', '--hard', 'HEAD'], e.seed); git(['fetch', '--quiet', 'origin', sha], e.seed); git(['checkout', '--quiet', '--detach', sha], e.seed);
    fs.writeFileSync(path.join(e.seed, 'README.md'), 'Another author\n'); git(['add', 'README.md'], e.seed);
    git(['commit', '--quiet', '-m', 'concurrent change'], e.seed, author); git(['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], e.seed);
    const other = git(['rev-parse', 'HEAD'], e.seed);
    await assert.rejects(rollbackSource({ base: e.spec.base, sha }, e.d), /master advanced/);
    assert.equal(await sourceHead(e.d), other); assert.equal(e.calls.writes, 1);
  } finally { e.cleanup(); }
});
test('an added repository in the dedicated connection disables write token issuance', async () => {
  const e = environment();
  try {
    e.d.google = async () => ({ json: async () => ({ repositories: [{ name: expectedRepo, remoteUri: github }, { name: 'other' }] }) });
    await assert.rejects(publish(e.spec, e.d), /connection repository scope changed/);
    assert.equal(e.calls.writes, 0);
  } finally { e.cleanup(); }
});
test('lost push response is reconciled with authoritative branch readback', async () => {
  const e = environment();
  try {
    const command = e.d.git;
    e.d.git = (args, cwd, env) => {
      const result = command(args, cwd, env);
      if (args[0] === 'push') throw new Error('response was lost');
      return result;
    };
    const sha = await publish(e.spec, e.d);
    assert.equal(await sourceHead(e.d), sha);
    assert.equal(e.calls.writes, 1);
  } finally { e.cleanup(); }
});
test('only the fixed project number is accepted as the repository resource alias', async () => {
  const e = environment();
  try {
    const google = e.d.google;
    e.d.google = async (url, init) => url.endsWith('/repositories')
      ? { json: async () => ({ repositories: [{ name: expectedRepo.replace('spectre-tomstocks-20260227', '569936489397'), remoteUri: github }] }) }
      : google(url, init);
    assert.match(await publish(e.spec, e.d), /^[0-9a-f]{40}$/);
  } finally { e.cleanup(); }
});
test('source access authenticates only a dry-run and leaves the remote branch unchanged', async () => {
  const e = environment();
  try {
    const command = e.d.git;
    e.d.git = (args, cwd, env) => {
      if (args[0] === 'push') {
        assert.ok(args.includes('--dry-run'));
        assert.equal(args.at(-1), `${e.spec.base}:refs/heads/master`);
        assert.ok(env.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));
      }
      return command(args, cwd, env);
    };
    assert.equal(await checkSourceAccess(e.d), true);
    assert.equal(await sourceHead(e.d), e.spec.base);
    assert.equal(e.calls.tokens, 1); assert.equal(e.calls.writes, 1);
  } finally { e.cleanup(); }
});
