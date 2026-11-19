import { createHash } from 'node:crypto';

export const STORE = 'manman-akihabara';
export const SUPABASE_ORIGIN = 'https://abyecthqjjssegwazhwm.supabase.co';
const PROJECT = 'spectre-tomstocks-20260227';
export const LOG_VIEW = 'projects/'+PROJECT+'/locations/global/buckets/_Default/views/haraka-tokyo-repair';
const GENERATE_JOB = 'haraka-manman-akihabara-generate';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const RUN_FIELDS = 'id,store,order_list_import_id,tokyo_snapshot_id,status,started_at,completed_at,prepare_done_at,plan_done_at,generate_done_at,generate_claimed_at,error_message';
const IMPORT_FIELDS = 'id,store,status,business_date,created_at,structural_valid,persistence_complete';

/** Only fixed categories and repository hints leave the trusted detector. Never return raw errors. */
export function classifyFailure(value) {
  const message = typeof value === 'string' ? value.slice(0, 16384) : '';
  const rules = [
    ['coverage_image_ambiguous', 'deterministic', /Oripark補完画像が曖昧/],
    ['coverage_identity_ambiguous', 'deterministic', /Oripark.*(?:複数商品|同一性|商品IDが重複)/],
    ['coverage_source_invalid', 'deterministic', /Oripark.*(?:元商品ID|元価格|画像証拠|主画像)/],
    ['coverage_missing', 'deterministic', /Oripark.*(?:欠落|網羅情報がありません|掲載画像がありません)/],
    ['source_stale', 'dependency', /(?:価格の鮮度が不足|価格日取得失敗|stale price)/i],
    ['dependency_auth', 'dependency', /(?:invalid_grant|unauthorized|permission denied|HTTP\s*40[13]\b)/i],
    ['rate_limit', 'transient', /(?:HTTP\s*429\b|too many requests|rate.?limit)/i],
    ['network', 'transient', /(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|timed?\s*out|HTTP\s*50[234]\b)/i],
  ];
  const match = rules.find(([, , pattern]) => pattern.test(message));
  return { code: match?.[0] ?? 'unknown', classification: match?.[1] ?? 'unknown',
    errorType: /\bTypeError\b/.test(message) ? 'TypeError' : /\bReferenceError\b/.test(message) ? 'ReferenceError' : 'Error' };
}

async function readJson(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch { throw new Error('Repair detector request failed'); }
  if (!response.ok) throw new Error(`Repair detector HTTP ${Number(response.status) || 0}`);
  try {
    const text = await response.text();
    if (text.length > 2000000) throw new Error();
    return JSON.parse(text);
  } catch { throw new Error('Repair detector response is invalid'); }
}

const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const jstDate = time => new Date(time + 9 * 3600000).toISOString().slice(0, 10);
function validImport(order, now) {
  if (!order || order.store !== STORE || !UUID.test(order.id) || !order.structural_valid || !order.persistence_complete
    || !['applied', 'failed', 'confirmed'].includes(order.status) || !/^\d{4}-\d{2}-\d{2}$/.test(order.business_date ?? '')) return false;
  const date = Date.parse(`${order.business_date}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== order.business_date) return false;
  const age = (Date.parse(jstDate(now)) - date) / DAY;
  return age >= 0 && age <= 1;
}
function validRun(run, order, now) {
  return run && run.store === STORE && UUID.test(run.id) && run.order_list_import_id === order.id
    && (!run.tokyo_snapshot_id || UUID.test(run.tokyo_snapshot_id))
    && Number.isFinite(timestamp(run.started_at)) && timestamp(run.started_at) <= now
    && now - timestamp(run.started_at) <= 2 * DAY;
}

/** Sheet failures are not persisted on Run. Correlate the exact Run to a Cloud Run execution first. */
export async function detectSheetFailure({ run, fetchImpl = fetch, accessToken, now = new Date() }) {
  if (!accessToken || !UUID.test(run.id) || !run.generate_done_at) return false;
  const from = new Date(timestamp(run.started_at)).toISOString();
  const until = new Date(now).toISOString();
  const scope = `resource.type="cloud_run_job" AND resource.labels.project_id="${PROJECT}" AND resource.labels.job_name="${GENERATE_JOB}"`;
  const query = filter => readJson(fetchImpl, 'https://logging.googleapis.com/v2/entries:list', {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ resourceNames: [LOG_VIEW], filter, orderBy: 'timestamp desc', pageSize: 10 }),
  });
  const claims = await query(`${scope} AND timestamp>="${from}" AND timestamp<="${until}" AND textPayload="[generate] Run claim参加: ${run.id}"`);
  const claim = claims.entries?.find(entry => entry.resource?.labels?.job_name === GENERATE_JOB
    && entry.textPayload === `[generate] Run claim参加: ${run.id}`);
  const execution = claim?.labels?.['run.googleapis.com/execution_name'];
  if (typeof execution !== 'string' || !/^haraka-manman-akihabara-generate-[a-z0-9-]+$/.test(execution)) return false;
  const failures = await query(`${scope} AND labels."run.googleapis.com/execution_name"="${execution}" AND timestamp>="${new Date(timestamp(run.generate_done_at)).toISOString()}" AND timestamp<="${until}" AND textPayload:"[generate] Google Sheet更新失敗（生成画像は完了状態を維持）:"`);
  const failure = (failures.entries ?? []).find(entry => entry.resource?.labels?.job_name === GENERATE_JOB
    && entry.labels?.['run.googleapis.com/execution_name'] === execution
    && typeof entry.textPayload === 'string'
    && entry.textPayload.startsWith('[generate] Google Sheet更新失敗（生成画像は完了状態を維持）:'));
  if (!failure) return false;
  const recovered = await query(`resource.type="cloud_run_job" AND resource.labels.project_id="${PROJECT}" AND timestamp>="${new Date(timestamp(run.generate_done_at)).toISOString()}" AND timestamp<="${until}" AND textPayload:"[buyback-sheet] published: store=${STORE}, run=${run.id},"`);
  return !(recovered.entries ?? []).some(entry => entry.resource?.labels?.job_name?.startsWith(`haraka-${STORE}-`)
    && typeof entry.textPayload === 'string' && entry.textPayload.startsWith(`[buyback-sheet] published: store=${STORE}, run=${run.id},`)
    && Number.isFinite(timestamp(entry.timestamp)) && Number.isFinite(timestamp(failure.timestamp))
    && timestamp(entry.timestamp) > timestamp(failure.timestamp));
}

/** Read-only and import-safe. Credentials and external text never enter the returned incident. */
export async function detect({ fetchImpl = fetch, now = new Date(), env = process.env,
  accessToken, sheetFailureReader = detectSheetFailure } = {}) {
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new Error('Repair detector clock is invalid');
  const configured = env.SUPABASE_URL?.replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  if (configured !== SUPABASE_ORIGIN || !key || (env.STORE_NAME && env.STORE_NAME !== STORE)) {
    throw new Error('Repair detector production database configuration is invalid');
  }
  const headers = { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${key}` }) };
  const dbRead = async (table, params) => {
    const body = await readJson(fetchImpl, `${SUPABASE_ORIGIN}/rest/v1/${table}?${new URLSearchParams(params)}`, { headers });
    if (!Array.isArray(body)) throw new Error('Repair detector database response is invalid');
    return body;
  };
  const loadImport = async () => (await dbRead('order_list_import', { select: IMPORT_FIELDS, store: `eq.${STORE}`,
    order: 'business_date.desc,created_at.desc,id.desc', limit: '1' }))[0];
  const order = await loadImport();
  if (!validImport(order, currentTime)) return null;
  const runParams = { select: RUN_FIELDS, store: `eq.${STORE}`, order_list_import_id: `eq.${order.id}`,
    order: 'started_at.desc,id.desc', limit: '30' };
  const runs = await dbRead('run', runParams);
  if (!runs.length || runs.some(run => !validRun(run, order, currentTime))) return null;
  const run = runs[0];
  // Active and stale generation claims belong to the existing watchdog, never to this dispatcher.
  if (runs.some(row => row.status === 'running') || !['failed', 'completed'].includes(run.status)) return null;
  let stage;
  let failure;
  let failedPageCount = 0;
  let sheetFailure = false;
  let failureText = run.error_message;
  if (run.status === 'failed' && !run.generate_done_at) {
    stage = run.plan_done_at ? 'generate' : 'sync';
    failure = classifyFailure(run.error_message);
  } else if (run.status === 'completed' && run.generate_done_at) {
    const pages = await dbRead('generated_page', { select: 'id,run_id,status,error_message', run_id: `eq.${run.id}`,
      status: 'eq.failed', limit: '1000' });
    if (pages.some(page => !UUID.test(page.id) || page.run_id !== run.id || page.status !== 'failed')) return null;
    failedPageCount = pages.length;
    if (failedPageCount) {
      const classifications = pages.map(page => classifyFailure(page.error_message));
      failure = classifications.find(item => item.classification === 'deterministic')
        ?? classifications.find(item => item.classification === 'unknown') ?? classifications[0];
      failureText = pages[classifications.indexOf(failure)].error_message;
      failure = { ...failure, code: `page_${failure.code}` };
    }
    // The access token stays in the trusted controller; worker payload only receives this boolean.
    if (accessToken) sheetFailure = await sheetFailureReader({ run, fetchImpl, accessToken, now });
    if (!failure && sheetFailure) failure = { code: 'sheet_publish_failed', classification: 'unknown', errorType: 'Error' };
    if (!failure) return null;
    stage = 'generate';
  } else return null; // A synced Run waiting for generation is owned by the watchdog.

  const matchingFailures = runs.filter(row => row.status === 'failed'
    && (row.plan_done_at ? 'generate' : 'sync') === stage
    && classifyFailure(row.error_message).code === failure.code).length;
  // Give ordinary network/rate-limit retries to the existing watchdog. Repeated failures become diagnosable.
  if (failure.classification === 'transient' && failedPageCount === 0 && matchingFailures < 3) return null;
  const diagnostic = { ...failure, matchingFailedRuns: matchingFailures, failedPageCount, sheetFailure,
    sheetMonitoring: accessToken ? 'cloud_logging' : 'not_observed',
    fileHints: [stage === 'sync' ? 'packages/job/src/jobs/sync.ts' : 'packages/job/src/jobs/generate.ts',
      ...(failure.code.startsWith('coverage_') ? ['packages/job/src/lib/oripark-coverage.ts', 'packages/job/src/lib/tokyo-normal-cards.ts'] : [])] };
  // Excludes Run IDs and timestamps, so retries of one root cause yield one durable controller claim.
  const unknownSignature = failure.code.endsWith('unknown') ? String(failureText ?? '').slice(0, 16384)
    .replace(/https?:\/\/\S+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\d+/gi, '#') : '';
  const fingerprint = createHash('sha256').update(JSON.stringify(['tokyo-repair-v1', STORE, order.id,
    order.business_date, stage, failure.code, failure.errorType, unknownSignature])).digest('hex');
  const latestOrder = await loadImport();
  const latestRuns = await dbRead('run', { ...runParams, limit: '1' });
  if (!validImport(latestOrder, currentTime) || latestOrder.id !== order.id || latestOrder.business_date !== order.business_date
    || !validRun(latestRuns[0], latestOrder, currentTime) || latestRuns[0]?.id !== run.id
    || latestRuns[0]?.status !== run.status || latestRuns[0]?.generate_done_at !== run.generate_done_at) return null;
  return { fingerprint, store: STORE, runId: run.id, importId: order.id, snapshotId: run.tokyo_snapshot_id ?? null,
    businessDate: order.business_date, stage, diagnostic };
}
