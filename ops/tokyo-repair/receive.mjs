import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, verify, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = 'nagatar-hub/HarakaforMANMAN';
export const REPO_ID = 1197998654;
export const APP_ID = 10529; // Read from GitHub /apps/google-cloud-build.
export const CERT_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/x509/haraka-tokyo-repair-ctl%40spectre-tomstocks-20260227.iam.gserviceaccount.com';
const REMOTE = `https://github.com/${REPO}.git`, MASTER = 'refs/heads/master';
const SHA = /^[0-9a-f]{40}$/;
// Same path boundary as policy.mjs; importing that file would require installing TypeScript.
export const ALLOWED_PATHS = new Set(['packages/job/src/lib/tokyo-normal-cards.ts',
  'packages/job/src/lib/oripark-coverage.ts', 'packages/job/src/lib/haraka-card-images.ts',
  'packages/job/src/lib/page-planner.ts', 'packages/job/src/jobs/generate.ts']);
const check = (ok, code) => { if (!ok) throw new Error(code); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

async function readJson(response, maxBytes) {
  check(response.ok, 'HTTP_FAILED');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; check(size <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('INVALID_JSON'); }
}

export async function verifyEnvelope(envelope, { now = Date.now(), fetchImpl = fetch } = {}) {
  check(exactKeys(envelope, ['payload', 'keyId', 'signature']), 'INVALID_ENVELOPE');
  const { payload, keyId, signature } = envelope;
  check(typeof payload === 'string' && payload.length <= 60000 && /^[A-Za-z0-9_-]+$/.test(payload), 'INVALID_PAYLOAD');
  check(typeof keyId === 'string' && /^[0-9a-f]{16,128}$/.test(keyId), 'INVALID_KEY_ID');
  check(typeof signature === 'string' && signature.length <= 1400 && /^[A-Za-z0-9+/]+={0,2}$/.test(signature), 'INVALID_SIGNATURE');
  const bytes = Buffer.from(payload, 'base64url'), signatureBytes = Buffer.from(signature, 'base64');
  check(bytes.toString('base64url') === payload && signatureBytes.toString('base64') === signature, 'NONCANONICAL_ENCODING');
  check(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), 'INVALID_UTF8');
  const certs = await readJson(await fetchImpl(CERT_URL, { redirect: 'error', signal: AbortSignal.timeout(15000) }), 65536);
  check(Object.hasOwn(certs, keyId) && typeof certs[keyId] === 'string' && certs[keyId].startsWith('-----BEGIN CERTIFICATE-----'), 'UNKNOWN_SIGNING_KEY');
  let cert;
  try { cert = new X509Certificate(certs[keyId]); } catch { throw new Error('INVALID_CERTIFICATE'); }
  check(cert.publicKey.asymmetricKeyType === 'rsa' && cert.publicKey.asymmetricKeyDetails.modulusLength >= 2048
    && Date.parse(cert.validFrom) <= now + 60000 && Date.parse(cert.validTo) >= now - 60000, 'INVALID_CERTIFICATE');
  check(verify('RSA-SHA256', Buffer.from('haraka-verified-source-v1\n' + payload, 'utf8'), cert.publicKey, signatureBytes), 'SIGNATURE_REJECTED');
  let wire;
  try { wire = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('INVALID_PAYLOAD_JSON'); }
  check(exactKeys(wire, ['version', 'repo', 'action', 'base', 'sha', 'commit', 'patch', 'issuedAt'])
    && wire.version === 1 && wire.repo === REPO && ['publish', 'rollback', 'probe'].includes(wire.action)
    && typeof wire.base === 'string' && SHA.test(wire.base) && typeof wire.sha === 'string' && SHA.test(wire.sha), 'INVALID_WIRE');
  const seconds = Math.floor(now / 1000);
  check(Number.isSafeInteger(wire.issuedAt) && wire.issuedAt <= seconds + 60 && wire.issuedAt >= seconds - 3600, 'STALE_SIGNATURE');
  check(typeof wire.commit === 'string' && Buffer.byteLength(wire.commit) <= 8192
    && typeof wire.patch === 'string' && Buffer.byteLength(wire.patch) <= 32768, 'INVALID_SOURCE_SIZE');
  if (wire.action === 'probe') check(wire.base === wire.sha && wire.commit === '' && wire.patch === '', 'INVALID_PROBE');
  else check(wire.base !== wire.sha && wire.commit.endsWith('\n') && wire.patch.endsWith('\n')
    && !wire.commit.includes('\0') && !wire.patch.includes('\0'), 'INVALID_SOURCE');
  return wire;
}

export function checkEvent(event) {
  check(event?.repository?.id === REPO_ID && event.repository.full_name === REPO
    && event.repository.default_branch === 'master' && event.context === 'haraka/tokyo-source-verified'
    && event.state === 'success' && typeof event.sha === 'string' && SHA.test(event.sha), 'UNTRUSTED_EVENT');
  const match = /^https:\/\/github\.com\/nagatar-hub\/HarakaforMANMAN\/runs\/([1-9][0-9]{0,15})$/.exec(event.target_url ?? '');
  check(match && Number.isSafeInteger(Number(match[1])), 'INVALID_CHECK_URL');
  return match[1];
}
export function checkRun(run, id, event) {
  check(run?.id === Number(id) && run.name === 'Haraka Tokyo verified source'
    && run.head_sha === event.sha && run.app?.id === APP_ID && run.app.slug === 'google-cloud-build'
    && run.status === 'completed' && run.conclusion === 'success', 'UNTRUSTED_CHECK');
  check(typeof run.output?.text === 'string' && Buffer.byteLength(run.output.text) <= 65535, 'INVALID_CHECK_OUTPUT');
  try { return JSON.parse(run.output.text); } catch { throw new Error('INVALID_CHECK_OUTPUT'); }
}

function git(args, cwd, { input, token } = {}) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${REMOTE}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:' + token).toString('base64')}` });
  const result = spawnSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
    '-c', 'protocol.file.allow=never', ...args], { cwd, env, input, encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: 60000, windowsHide: true });
  check(result.status === 0, 'GIT_OPERATION_FAILED');
  return result.stdout;
}
function remoteHead(run, cwd) {
  const match = /^([0-9a-f]{40})\s+refs\/heads\/master\s*$/.exec(run(['ls-remote', '--exit-code', REMOTE, MASTER], cwd));
  check(match, 'INVALID_REMOTE_HEAD'); return match[1];
}
function commitTree(wire) {
  const split = wire.commit.indexOf('\n\n'); check(split > 0, 'INVALID_COMMIT');
  const headers = wire.commit.slice(0, split).split('\n');
  check(headers.length === 4 && /^tree [0-9a-f]{40}$/.test(headers[0]) && headers[1] === 'parent ' + wire.base
    && /^author [^\r\n]+$/.test(headers[2]) && /^committer [^\r\n]+$/.test(headers[3]), 'INVALID_COMMIT_HEADERS');
  const bytes = Buffer.from(wire.commit, 'utf8');
  check(createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex') === wire.sha, 'COMMIT_HASH_MISMATCH');
  return headers[0].slice(5);
}

/** Never executes candidate code or checks out its commit. Only the index is used to validate its tree. */
export function applyVerifiedSource(wire, { token, gitImpl = git, root = fs.mkdtempSync(path.join(os.tmpdir(), 'haraka-receive-')) } = {}) {
  check(typeof token === 'string' && token.length > 10 && !/[\r\n]/.test(token), 'MISSING_GITHUB_TOKEN');
  const run = gitImpl;
  try {
    run(['init', '--quiet'], root);
    run(['remote', 'add', 'origin', REMOTE], root);
    const current = remoteHead(run, root);
    check(current === wire.base || current === wire.sha, 'MASTER_ADVANCED');
    run(['fetch', '--depth=1', 'origin', wire.base], root);
    check(run(['rev-parse', 'FETCH_HEAD'], root).trim() === wire.base, 'BASE_MISMATCH');
    run(['checkout', '--detach', '--quiet', wire.base], root);
    if (wire.action !== 'probe') {
      const expectedTree = commitTree(wire);
      run(['apply', '--index', '--whitespace=nowarn', '-'], root, { input: wire.patch });
      const names = run(['diff', '--cached', '--name-only', '-z'], root).split('\0').filter(Boolean);
      check(names.length > 0 && names.length <= 2 && new Set(names).size === names.length
        && names.every(name => ALLOWED_PATHS.has(name)), 'PATH_NOT_ALLOWED');
      check(run(['diff', '--cached', '--diff-filter=ACDRTUXB', '--name-only', '-z'], root) === '', 'FILE_TYPE_CHANGED');
      const index = run(['ls-files', '--stage', '-z', '--', ...names], root).split('\0').filter(Boolean);
      check(index.length === names.length && index.every(line => /^100644 [0-9a-f]{40} 0\t/.test(line)), 'FILE_MODE_CHANGED');
      check(run(['write-tree'], root).trim() === expectedTree, 'TREE_MISMATCH');
      check(run(['hash-object', '-t', 'commit', '-w', '--stdin'], root, { input: wire.commit }).trim() === wire.sha, 'COMMIT_HASH_MISMATCH');
    }
    const latest = remoteHead(run, root);
    check(latest === wire.base || latest === wire.sha, 'MASTER_ADVANCED');
    if (wire.action === 'probe') run(['push', '--dry-run', '--no-verify', '--porcelain', 'origin', `${wire.sha}:${MASTER}`], root, { token });
    else if (latest !== wire.sha) run(['push', '--no-verify', '--porcelain', 'origin', `${wire.sha}:${MASTER}`], root, { token });
    check(remoteHead(run, root) === wire.sha, 'PUSH_READBACK_MISMATCH');
    return { action: wire.action, sha: wire.sha };
  } finally {
    // Only mkdtemp's known prefix under the host temporary directory is eligible for removal.
    const absolute = path.resolve(root);
    if (path.dirname(absolute) === path.resolve(os.tmpdir()) && path.basename(absolute).startsWith('haraka-receive-')) {
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  }
}

export async function receive(event, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch, now = Date.now(), apply = applyVerifiedSource } = {}) {
  const id = checkEvent(event);
  check(typeof token === 'string' && token.length > 10 && !/[\r\n]/.test(token), 'MISSING_GITHUB_TOKEN');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const checkUrl = `https://api.github.com/repos/${REPO}/check-runs/${id}`;
  const run = await readJson(await fetchImpl(checkUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }), 131072);
  const wire = await verifyEnvelope(checkRun(run, id, event), { fetchImpl, now });
  check(wire.base === event.sha, 'EVENT_BASE_MISMATCH');
  const result = await apply(wire, { token });
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}/statuses/${event.sha}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ state: 'success', context: `haraka/tokyo-source-${wire.action}/${id}`,
      description: wire.action === 'probe' ? 'Verified receiver and receive-pack access' : 'Verified source fast-forward completed' }),
  });
  check(response.ok, 'STATUS_WRITE_FAILED');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.env.GITHUB_EVENT_NAME === 'status' && process.env.GITHUB_REPOSITORY === REPO, 'UNTRUSTED_RUNTIME');
    const eventPath = process.env.GITHUB_EVENT_PATH;
    check(eventPath && fs.statSync(eventPath).size <= 1024 * 1024, 'INVALID_EVENT_FILE');
    await receive(JSON.parse(fs.readFileSync(eventPath, 'utf8')));
    console.log('Verified source request completed');
  } catch (error) { console.error(/^[A-Z_]+$/.test(error?.message) ? error.message : 'RECEIVE_FAILED'); process.exitCode = 1; }
}
