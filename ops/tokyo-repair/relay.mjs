import { createHash } from 'node:crypto';
import { google, expectedRepo, github, json } from './cloud.mjs';

export const RELAY_REPO = 'nagatar-hub/HarakaforMANMAN';
export const RELAY_CHECK = 'Haraka Tokyo verified source';
export const RELAY_CONTEXT = 'haraka/tokyo-source-verified';
export const RELAY_SIGNING_PREFIX = 'haraka-verified-source-v1\n';
const SIGNER = 'haraka-tokyo-repair-ctl@spectre-tomstocks-20260227.iam.gserviceaccount.com';
const NUMBERED_REPOSITORY = expectedRepo.replace('projects/spectre-tomstocks-20260227/', 'projects/569936489397/');
const SHA = /^[0-9a-f]{40}$/;
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function encodeRelayPayload(wire) {
  const fields = ['version', 'repo', 'action', 'base', 'sha', 'commit', 'patch', 'issuedAt'];
  if (!wire || Object.keys(wire).length !== fields.length || fields.some(key => !Object.hasOwn(wire, key))
    || wire.version !== 1 || wire.repo !== RELAY_REPO || !['publish', 'rollback', 'probe'].includes(wire.action)
    || !SHA.test(wire.base ?? '') || !SHA.test(wire.sha ?? '') || !Number.isSafeInteger(wire.issuedAt) || wire.issuedAt <= 0
    || typeof wire.commit !== 'string' || typeof wire.patch !== 'string') fail('SOURCE_RELAY_INVALID_PAYLOAD');
  if (wire.action === 'probe') {
    if (wire.sha !== wire.base || wire.commit !== '' || wire.patch !== '') fail('SOURCE_RELAY_INVALID_PROBE');
  } else {
    if (wire.sha === wire.base || !wire.commit.endsWith('\n') || wire.commit.endsWith('\n\n')
      || !wire.patch.startsWith('diff --git ') || !wire.patch.endsWith('\n')) fail('SOURCE_RELAY_INVALID_PATCH');
    const bytes = Buffer.from(wire.commit, 'utf8');
    if (bytes.length > 8192 || Buffer.byteLength(wire.patch, 'utf8') > 32768) fail('SOURCE_RELAY_PAYLOAD_TOO_LARGE');
    const actual = createHash('sha1').update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
    const parents = [...wire.commit.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(match => match[1]);
    if (actual !== wire.sha || parents.length !== 1 || parents[0] !== wire.base) fail('SOURCE_RELAY_COMMIT_MISMATCH');
  }
  const payload = Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
  if (payload.length > 60000) fail('SOURCE_RELAY_PAYLOAD_TOO_LARGE');
  return payload;
}

async function checksToken(d) {
  const collection = expectedRepo.slice(0, expectedRepo.lastIndexOf('/repositories/')) + '/repositories';
  const listed = await (await d.google(`https://cloudbuild.googleapis.com/v2/${collection}`)).json();
  if (listed.nextPageToken || listed.repositories?.length !== 1
    || ![expectedRepo, NUMBERED_REPOSITORY].includes(listed.repositories[0].name)
    || listed.repositories[0].remoteUri !== github) fail('SOURCE_CONNECTION_SCOPE_CHANGED');
  const value = await (await d.google(`https://cloudbuild.googleapis.com/v2/${expectedRepo}:accessReadWriteToken`, json('POST', {}))).json();
  if (typeof value.token !== 'string' || value.token.length < 10 || /[\r\n]/.test(value.token)
    || value.expirationTime && (!Number.isFinite(Date.parse(value.expirationTime)) || Date.parse(value.expirationTime) <= d.now() + 30000)) fail('SOURCE_CHECKS_TOKEN_UNAVAILABLE');
  return value.token;
}

/** Publish only signed, verified source bytes. Google/OAuth credentials never leave this process. */
export async function relaySource(request, options = {}) {
  const d = { google, fetch, now: Date.now, sleep: delay, pollMs: 3000, maxPolls: 180, ...options };
  if (typeof d.readHead !== 'function') fail('SOURCE_RELAY_READBACK_REQUIRED');
  const wire = { version: 1, repo: RELAY_REPO, ...request, issuedAt: Math.floor(d.now() / 1000) };
  const payload = encodeRelayPayload(wire);
  const signatureInput = Buffer.from(RELAY_SIGNING_PREFIX + payload, 'utf8').toString('base64');
  const signed = await (await d.google(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SIGNER}:signBlob`, json('POST', { payload: signatureInput }))).json();
  if (typeof signed.keyId !== 'string' || !/^[a-f0-9]{16,128}$/i.test(signed.keyId)
    || typeof signed.signedBlob !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signedBlob)
    || signed.signedBlob.length < 80 || signed.signedBlob.length > 1400) fail('SOURCE_RELAY_SIGNATURE_INVALID');
  const text = JSON.stringify({ payload, keyId: signed.keyId, signature: signed.signedBlob });
  if (text.length > 65000) fail('SOURCE_RELAY_PAYLOAD_TOO_LARGE');
  let token = await checksToken(d);
  const api = async (path, body, phase) => {
    let response;
    try {
      response = await d.fetch(`https://api.github.com/repos/${RELAY_REPO}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { fail(`SOURCE_RELAY_${phase}_NETWORK`, { phase, uncertain: true }); }
    if (!response.ok) fail(`SOURCE_RELAY_${phase}_HTTP_${response.status}`, { status: response.status, phase, uncertain: response.status >= 500 });
    try { return await response.json(); } catch { fail(`SOURCE_RELAY_${phase}_INVALID_RESPONSE`, { phase, uncertain: true }); }
  };
  let checkId;
  let triggered = false;
  try {
    const current = await d.readHead();
    if (wire.action !== 'probe' && current === wire.sha) return { sha: wire.sha, alreadyPublished: true };
    if (current !== wire.base) fail('SOURCE_RELAY_BASE_CHANGED');
    const check = await api('check-runs', { name: RELAY_CHECK, head_sha: wire.base, status: 'completed', conclusion: 'success',
      completed_at: new Date(d.now()).toISOString(), output: { title: RELAY_CHECK,
        summary: 'Signed source publication request from the Tokyo repair controller.', text } }, 'CHECK');
    if (!Number.isSafeInteger(check?.id) || check.id <= 0 || check.name !== RELAY_CHECK || check.head_sha !== wire.base
      || check.output?.text !== text) fail('SOURCE_RELAY_CHECK_MISMATCH');
    checkId = check.id;
    triggered = true;
    try {
      await api(`statuses/${wire.base}`, { context: RELAY_CONTEXT, state: 'success',
        target_url: `https://github.com/${RELAY_REPO}/runs/${checkId}`, description: 'Verified source request ready for signature validation' }, 'TRIGGER');
    } catch (error) { if (!error.uncertain) throw error; }
    for (let poll = 0; poll < d.maxPolls; poll++) {
      const head = await d.readHead();
      if (wire.action !== 'probe' && head === wire.sha) return { sha: wire.sha, checkId };
      if (head !== wire.base) fail('SOURCE_RELAY_BASE_CHANGED', { checkRunId: checkId, expectedSha: wire.sha });
      // This status is produced by the receiver's GITHUB_TOKEN after its own dry-run/verification.
      const statuses = await api(`commits/${wire.base}/statuses?per_page=100`, undefined, 'STATUS');
      if (!Array.isArray(statuses)) fail('SOURCE_RELAY_STATUS_INVALID');
      const context = `haraka/tokyo-source-${wire.action}/${checkId}`;
      const status = statuses.find(item => item.context === context && item.creator?.login === 'github-actions[bot]' && item.creator.type === 'Bot');
      if (status?.state === 'failure' || status?.state === 'error') fail('SOURCE_RELAY_RECEIVER_REJECTED', { checkRunId: checkId });
      if (wire.action === 'probe' && status?.state === 'success') {
        if (await d.readHead() !== wire.base) fail('SOURCE_RELAY_BASE_CHANGED', { checkRunId: checkId });
        return { sha: wire.sha, checkId, probe: true };
      }
      await d.sleep(d.pollMs);
    }
    fail('SOURCE_RELAY_TIMEOUT', { checkRunId: checkId, expectedSha: wire.sha });
  } catch (error) {
    if (triggered && (!error.code || error.uncertain || error.code === 'SOURCE_RELAY_STATUS_INVALID')) {
      fail('SOURCE_RELAY_TIMEOUT', { checkRunId: checkId, expectedSha: wire.sha, phase: error.phase, status: error.status });
    }
    throw error;
  } finally { token = ''; }
}
