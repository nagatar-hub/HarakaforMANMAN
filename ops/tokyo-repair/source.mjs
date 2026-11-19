import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkout, git } from './worker.mjs';
import { google, github } from './cloud.mjs';
import { applyProposal } from './policy.mjs';
import { relaySource } from './relay.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MASTER = 'refs/heads/master';
const RUNTIME_PATHS = ['packages/job', 'packages/shared', 'package.json', 'package-lock.json', 'tsconfig.base.json', '.npmrc', '.dockerignore'];
const check = (ok, reason) => { if (!ok) throw new Error(`Repair source: ${reason}`); };
const lines = value => value.split('\n').filter(Boolean).sort();
const equal = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

function deps(overrides = {}) {
  return { git, gitRaw, checkout, applyProposal, google, relaySource, ...overrides };
}
function gitRaw(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (result.status !== 0) throw Object.assign(new Error('SOURCE_GIT_RAW_READ_FAILED'), { code: 'SOURCE_GIT_RAW_READ_FAILED' });
  return result.stdout;
}
function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'haraka-repair-source-')); }
function discard(root) {
  // Only the exact directory created by mkdtemp above is eligible for cleanup.
  const resolved = path.resolve(root);
  check(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('haraka-repair-source-'), 'unsafe cleanup target');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function readHead(d, cwd) {
  const response = d.git(['ls-remote', '--exit-code', github, MASTER], cwd);
  const found = response.split(/\s+/);
  check(found.length === 2 && SHA.test(found[0]) && found[1] === MASTER, 'remote branch not found');
  return found[0];
}

/** Public, read-only remote lookup. No GitHub write token is requested. */
export async function sourceHead(overrides = {}) {
  const d = deps(overrides), root = scratch();
  try { return readHead(d, root); } finally { discard(root); }
}

/** Ask the trusted receiver to dry-run using its short-lived GITHUB_TOKEN, then read its result. */
export async function checkSourceAccess(overrides = {}) {
  const d = deps(overrides), root = scratch();
  try {
    const head = readHead(d, root);
    d.checkout(root, head);
    const result = await d.relaySource({ action: 'probe', base: head, sha: head, commit: '', patch: '' }, relayOptions(d, root));
    check(result?.probe === true && result.sha === head, 'probe result missing');
    check(readHead(d, root) === head, 'master changed during access check');
    return true;
  } finally { discard(root); }
}

export async function assertDeployedSource(base, deployedRev, overrides = {}) {
  check(SHA.test(base ?? '') && SHA.test(deployedRev ?? ''), 'invalid deployed revision');
  if (base === deployedRev) return true;
  const d = deps(overrides), root = scratch();
  try {
    d.checkout(root, base);
    d.git(['fetch', '--depth=1', 'origin', deployedRev], root);
    const changed = d.git(['diff', '--name-only', deployedRev, base, '--', ...RUNTIME_PATHS], root);
    check(!changed, 'runtime source differs from production');
    return true;
  } finally { discard(root); }
}

function identity(d, root, parent) {
  // A restart produces exactly the same commit ID, even when the controller clock has advanced.
  const seconds = Number(d.git(['show', '-s', '--format=%ct', parent], root));
  check(Number.isSafeInteger(seconds) && seconds > 0, 'invalid parent timestamp');
  const date = `${seconds + 1} +0000`;
  return { GIT_AUTHOR_NAME: 'Haraka Tokyo Repair', GIT_AUTHOR_EMAIL: 'haraka-tokyo-repair@tomstocks.net',
    GIT_COMMITTER_NAME: 'Haraka Tokyo Repair', GIT_COMMITTER_EMAIL: 'haraka-tokyo-repair@tomstocks.net',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}
function commit(d, root, tree, parent, message) {
  const sha = d.git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', parent, '-m', message], root, identity(d, root, parent));
  check(SHA.test(sha), 'invalid commit result');
  return sha;
}
function relayOptions(d, root) {
  return { google: d.google, readHead: () => readHead(d, root), ...(d.fetch ? { fetch: d.fetch } : {}) };
}
async function pushChild(d, root, parent, sha, action) {
  const current = readHead(d, root);
  if (current === sha) return sha; // Push succeeded before a previous controller stopped.
  check(current === parent, 'master advanced');
  const rawCommit = d.gitRaw(['cat-file', 'commit', sha], root);
  const patch = d.gitRaw(['diff', '--binary', '--full-index', '--no-ext-diff', parent, sha], root);
  try { await d.relaySource({ action, base: parent, sha, commit: rawCommit, patch }, relayOptions(d, root)); }
  catch (error) {
    let observed;
    try { observed = readHead(d, root); } catch { /* Keep the original uncertain publication result. */ }
    if (observed !== sha) throw error;
  }
  check(readHead(d, root) === sha, 'push readback mismatch');
  return sha;
}

/** Rebuild the reviewed tree using the trusted policy before obtaining any write credential. */
export async function publish({ attempt, base, stage, proposal, verified }, overrides = {}) {
  check(ATTEMPT.test(attempt ?? '') && SHA.test(base ?? '') && ['sync', 'generate'].includes(stage), 'invalid publication identity');
  check(proposal?.base === base && proposal.stage === stage && proposal.decision === 'repair', 'proposal identity mismatch');
  check(verified?.base === base && verified.stage === stage && SHA.test(verified.tree ?? '')
    && Array.isArray(verified.files) && verified.files.length > 0 && new Set(verified.files).size === verified.files.length, 'verification identity mismatch');
  const d = deps(overrides), root = scratch();
  try {
    d.checkout(root, base);
    const files = d.applyProposal(root, stage, proposal);
    check(equal(files, verified.files) && equal(lines(d.git(['diff', '--name-only'], root)), files), 'verified files mismatch');
    d.git(['add', '--', ...files], root);
    check(equal(lines(d.git(['diff', '--cached', '--name-only'], root)), files), 'staged files mismatch');
    const tree = d.git(['write-tree'], root);
    check(tree === verified.tree, 'verified tree mismatch');
    const message = `fix(tokyo): automated ${stage} repair\n\nRepair-Attempt: ${attempt}\nBase-Revision: ${base}\nVerified-Tree: ${tree}\n`;
    const sha = commit(d, root, tree, base, message);
    return await pushChild(d, root, base, sha, 'publish');
  } finally { discard(root); }
}

/** Restore the original tree with a new child commit. Never reset or overwrite another author's work. */
export async function rollbackSource({ base, sha }, overrides = {}) {
  check(SHA.test(base ?? '') && SHA.test(sha ?? '') && base !== sha, 'invalid rollback identity');
  const d = deps(overrides), root = scratch();
  try {
    d.checkout(root, sha);
    d.git(['fetch', '--depth=1', 'origin', base], root);
    const object = d.git(['cat-file', '-p', sha], root);
    const parents = [...object.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => match[1]);
    check(parents.length === 1 && parents[0] === base && object.includes(`\nBase-Revision: ${base}\n`)
      && /^Repair-Attempt: [0-9a-f-]{36}$/m.test(object) && /^Verified-Tree: [0-9a-f]{40}$/m.test(object), 'not the recorded repair commit');
    const tree = d.git(['rev-parse', `${base}^{tree}`], root);
    check(SHA.test(tree), 'invalid rollback tree');
    const reverted = commit(d, root, tree, sha, `revert(tokyo): compensate failed automatic repair\n\nRepair-Reverted: ${sha}\nBase-Revision: ${base}\n`);
    return await pushChild(d, root, sha, reverted, 'rollback');
  } finally { discard(root); }
}
