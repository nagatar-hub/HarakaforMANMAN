import { createHash, randomUUID } from 'node:crypto';

// This module runs only in the trusted controller. Never import it into the Codex worker.
export const TOKYO_STORE = 'manman-akihabara';
const PROJECT = 'spectre-tomstocks-20260227';
const REGION = 'asia-northeast1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const RUN_SELECT = 'id,store,status,order_list_import_id,order_list_sync_request_id,order_list_sync_request_fingerprint,tokyo_snapshot_id,started_at,import_done_at,prepare_done_at,plan_done_at,generate_done_at,completed_at,generate_claimed_at,total_prepared,total_image_ng,total_pages,error_message';
const IMPORT_SELECT = 'id,store,business_date,status,structural_valid,persistence_complete,confirmation_allow_unresolved,created_at';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const jstDate = now => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const fail = (code, detail = '') => { throw new RecoveryError(code, detail); };

export class RecoveryError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'RecoveryError'; this.code = code; }
}

export function recoveryRequestId(fingerprint) {
  if (!HASH.test(fingerprint ?? '')) fail('INVALID_INCIDENT');
  const hash = sha256(`tokyo-repair-v1:${fingerprint}`);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function validateIncident(incident) {
  if (!incident || incident.store !== TOKYO_STORE || !UUID.test(incident.runId ?? '')
    || !UUID.test(incident.importId ?? '') || !HASH.test(incident.fingerprint ?? '')
    || (incident.snapshotId != null && !UUID.test(incident.snapshotId))) fail('INVALID_INCIDENT');
  if (!['sync', 'prepare', 'generate'].includes(incident.stage)) fail('UNKNOWN_FAILURE_STAGE');
}

export function observedStage(run) {
  if (run.generate_done_at) return 'complete';
  if (run.plan_done_at && run.prepare_done_at) return 'generate';
  if (!run.prepare_done_at && !run.plan_done_at) return 'sync';
  return 'unknown';
}

async function jsonRequest(fetcher, url, init = {}, code = 'REMOTE_READ_FAILED') {
  let response;
  try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { fail(code); }
  // Do not forward remote bodies, headers, URLs or credential-bearing exceptions to logs/Codex.
  if (!response.ok) fail(code, `HTTP ${response.status}`);
  try { return await response.json(); } catch { fail(code, 'invalid JSON'); }
}

function restDatabase(env, fetcher) {
  if (env.SUPABASE_URL !== 'https://abyecthqjjssegwazhwm.supabase.co' || !env.SUPABASE_SERVICE_ROLE_KEY) {
    fail('DATABASE_TARGET_NOT_CONFIGURED');
  }
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' };
  if (!env.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
  return {
    async rows(table, filters, select = '*', order = 'id.asc', limit = null) {
      const result = [];
      for (let offset = 0; ; offset += 500) {
        const query = new URLSearchParams({ select, ...filters, order, offset: String(offset), limit: String(limit ?? 500) });
        const page = await jsonRequest(fetcher, `${env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers });
        if (!Array.isArray(page)) fail('DATABASE_READ_SHAPE');
        result.push(...page);
        if (limit != null || page.length < 500) return result;
        if (offset > 100000) fail('DATABASE_READ_LIMIT');
      }
    },
    async rpc(name, args) {
      return jsonRequest(fetcher, `${env.SUPABASE_URL}/rest/v1/rpc/${name}`,
        { method: 'POST', headers, body: JSON.stringify(args) }, 'QUEUE_FAILED');
    },
    async claimGenerate(run, now) {
      // The token is read and used only here, in the trusted adapter; it never enters diagnostics.
      const query = new URLSearchParams({ id: `eq.${run.id}`, store: `eq.${TOKYO_STORE}`,
        select: 'generate_claim_token,generate_claimed_at,status', limit: '1' });
      const [current] = await jsonRequest(fetcher, `${env.SUPABASE_URL}/rest/v1/run?${query}`, { headers });
      if (!current || current.status !== run.status || current.generate_claimed_at !== run.generate_claimed_at) return null;
      const token = randomUUID();
      const filter = new URLSearchParams({ id: `eq.${run.id}`, store: `eq.${TOKYO_STORE}`,
        order_list_import_id: `eq.${run.order_list_import_id}`, status: `eq.${run.status}`,
        plan_done_at: 'not.is.null', generate_done_at: 'is.null',
        generate_claim_token: current.generate_claim_token ? `eq.${current.generate_claim_token}` : 'is.null',
        generate_claimed_at: current.generate_claimed_at ? `eq.${current.generate_claimed_at}` : 'is.null', select: 'id' });
      const rows = await jsonRequest(fetcher, `${env.SUPABASE_URL}/rest/v1/run?${filter}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'running', error_message: null, generate_claimed_at: now.toISOString(), generate_claim_token: token }),
      }, 'GENERATE_CLAIM_FAILED');
      return rows?.length === 1 ? token : null;
    },
    async releaseUnstartedGenerate(run, token, now) {
      const filter = new URLSearchParams({ id: `eq.${run.id}`, store: `eq.${TOKYO_STORE}`, status: 'eq.running',
        generate_done_at: 'is.null', generate_claim_token: `eq.${token}`, generate_claimed_at: `eq.${now.toISOString()}` });
      await jsonRequest(fetcher, `${env.SUPABASE_URL}/rest/v1/run?${filter}`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ status: run.status, error_message: run.error_message, generate_claimed_at: null, generate_claim_token: null }),
      }, 'GENERATE_RELEASE_FAILED');
    },
  };
}

function dependencies(overrides = {}) {
  const env = overrides.env ?? process.env;
  const fetcher = overrides.fetch ?? fetch;
  const metadataToken = async () => {
    const result = await jsonRequest(fetcher,
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }, 'METADATA_AUTH_FAILED');
    if (typeof result.access_token !== 'string') fail('METADATA_AUTH_FAILED');
    return result.access_token;
  };
  return {
    env,
    db: overrides.db ?? restDatabase(env, fetcher),
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    pollMs: overrides.pollMs ?? 10000,
    timeoutMs: overrides.timeoutMs ?? 80 * 60 * 1000,
    async launch(kind, values) {
      if (overrides.launch) return overrides.launch(kind, values);
      if (!['sync', 'generate'].includes(kind)) fail('INVALID_JOB');
      const token = await metadataToken();
      return jsonRequest(fetcher, `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/haraka-${TOKYO_STORE}-${kind}:run`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: { taskCount: 1, containerOverrides: [{ env: Object.entries(values).map(([name, value]) => ({ name, value })) }] } }),
      }, 'LAUNCH_RESULT_UNKNOWN');
    },
    async consumer(runId, revision) {
      if (overrides.consumer) return overrides.consumer(runId, revision);
      let url;
      try { url = new URL(env.PELEKA_TOKYO_CATALOG_URL); } catch { fail('CONSUMER_NOT_CONFIGURED'); }
      if (url.protocol !== 'https:' || url.username || url.password || !env.PELEKA_TOKYO_CATALOG_TOKEN) fail('CONSUMER_NOT_CONFIGURED');
      url.searchParams.set('runId', runId); url.searchParams.set('revision', String(revision));
      return jsonRequest(fetcher, url, { headers: { Authorization: `Bearer ${env.PELEKA_TOKYO_CATALOG_TOKEN}` } }, 'CONSUMER_READ_FAILED');
    },
    async readFixture(runId, stage) {
      if (overrides.readFixture) return overrides.readFixture(runId, stage);
      const bucket = env.TOKYO_REPAIR_FIXTURE_BUCKET;
      if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket ?? '')) fail('FIXTURE_NOT_CONFIGURED');
      const token = await metadataToken();
      const names = stage === 'generate_plan' ? ['generate-plan'] : ['coverage-prepare', 'prepare'];
      for (const name of names) {
        const object = encodeURIComponent(`tokyo-repair-fixtures/${runId}/${name}.json`);
        try { return await jsonRequest(fetcher, `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`,
          { headers: { Authorization: `Bearer ${token}` } }, 'FIXTURE_UNAVAILABLE'); }
        catch (error) { if (error.message !== 'FIXTURE_UNAVAILABLE: HTTP 404') throw error; }
      }
      fail('FIXTURE_UNAVAILABLE');
    },
  };
}

async function one(db, table, filters, select, order = 'id.asc') {
  return (await db.rows(table, filters, select, order, 1))[0] ?? null;
}
async function runById(db, id) {
  return one(db, 'run', { id: `eq.${id}`, store: `eq.${TOKYO_STORE}` }, RUN_SELECT);
}
async function latestContext(d, importId) {
  const order = await one(d.db, 'order_list_import', { store: `eq.${TOKYO_STORE}` }, IMPORT_SELECT, 'business_date.desc,created_at.desc,id.desc');
  if (!order || order.id !== importId || order.business_date !== jstDate(d.now())) fail('IMPORT_SUPERSEDED_OR_NOT_TODAY');
  if (!order.structural_valid || !order.persistence_complete) fail('IMPORT_NOT_PERSISTED');
  const latest = await one(d.db, 'run', { store: `eq.${TOKYO_STORE}`, order_list_import_id: `eq.${order.id}` }, RUN_SELECT, 'started_at.desc,id.desc');
  return { order, latest };
}
async function incidentContext(incident, d, allowCompleted = false) {
  validateIncident(incident);
  const { order, latest } = await latestContext(d, incident.importId);
  const original = await runById(d.db, incident.runId);
  if (!original || original.order_list_import_id !== order.id || original.tokyo_snapshot_id !== (incident.snapshotId ?? null)) fail('INCIDENT_CHANGED');
  const stage = observedStage(original);
  if (stage !== (incident.stage === 'prepare' ? 'sync' : incident.stage)
    && !(allowCompleted && incident.stage === 'generate' && stage === 'complete')) fail('FAILURE_STAGE_CHANGED');
  if (!latest) fail('RUN_NOT_FOUND');
  return { order, latest, original };
}

/** Read-only capture. A missing or unsupported fixture blocks deployment, rather than manufacturing a passing replay. */
export async function captureReplayFixture(incident, overrides = {}) {
  const d = dependencies(overrides);
  const { original, latest } = await incidentContext(incident, d);
  if (original.id !== latest.id || original.status !== 'failed' || !original.error_message) fail('INCIDENT_NOT_CURRENT_FAILURE');
  const stage = observedStage(original) === 'sync' ? 'prepare' : 'generate_plan';
  const fixture = await d.readFixture(original.id, stage);
  validatePrepareFixture(fixture);
  if (!(fixture.stage === stage || stage === 'prepare' && fixture.stage === 'coverage_prepare') || fixture.runId !== original.id || fixture.importId !== incident.importId
    || fixture.snapshotId !== (incident.snapshotId ?? null) || fixture.errorSha256 !== sha256(original.error_message)) fail('FIXTURE_INCIDENT_MISMATCH');
  return { ...fixture, incidentFingerprint: incident.fingerprint, inputSha256: sha256(fixture.input) };
}

export function validatePrepareFixture(fixture) {
  if (!fixture || fixture.schemaVersion !== 1 || fixture.store !== TOKYO_STORE || !['prepare', 'coverage_prepare', 'generate_plan'].includes(fixture.stage)
    || !UUID.test(fixture.runId ?? '') || !UUID.test(fixture.importId ?? '')
    || (fixture.snapshotId != null && !UUID.test(fixture.snapshotId)) || !HASH.test(fixture.errorSha256 ?? '')
    || !Number.isFinite(Date.parse(fixture.capturedAt))) fail('FIXTURE_INVALID');
  const input = fixture.input;
  if (!input) fail('FIXTURE_INVALID');
  if (fixture.stage === 'prepare' && (input.snapshot?.store !== TOKYO_STORE || input.snapshot.order_list_import_id !== fixture.importId
    || !Array.isArray(input.products) || !input.products.length || !Array.isArray(input.imageMappings) || !Array.isArray(input.dbCards))) fail('FIXTURE_INVALID');
  if (fixture.stage === 'generate_plan' && (!Array.isArray(input.cards) || !input.cards.length
    || !Array.isArray(input.layouts) || !Array.isArray(input.rules))) fail('FIXTURE_INVALID');
  if (fixture.stage === 'coverage_prepare' && (input.snapshot?.store !== TOKYO_STORE
    || input.snapshot.order_list_import_id !== fixture.importId || !Array.isArray(input.preCoverage?.products)
    || !input.preCoverage.priceSources || !Array.isArray(input.baseline?.cards) || !input.baseline.cards.length
    || !Array.isArray(input.imageMappings) || !Array.isArray(input.dbCards)
    || !input.snapshot.settings?.tokyo_source_discount_rates || !input.snapshot.settings?.tokyo_outlier_guard
    || !Number.isSafeInteger(input.snapshot.settings?.tokyo_price_max_age_days))) fail('FIXTURE_INVALID');
  if (fixture.inputSha256 && sha256(input) !== fixture.inputSha256) fail('FIXTURE_HASH_MISMATCH');
  const rows = fixture.stage === 'coverage_prepare' ? input.preCoverage.products : fixture.stage === 'prepare' ? input.products : input.cards;
  if (new Set(rows.map(p => p.id)).size !== rows.length) fail('FIXTURE_DUPLICATE_PRODUCTS');
  return true;
}

const unique = array => new Set(array).size === array.length;
const sameIds = (left, right) => {
  if (!unique(left) || !unique(right) || left.length !== right.length) return false;
  const sorted = [...right].sort();
  return [...left].sort().every((id, index) => id === sorted[index]);
};
const samePrices = (left, right) => Number.isSafeInteger(left.price_high) && left.price_high > 0
  && Number.isSafeInteger(left.price_low) && left.price_low >= 0 && left.price_low <= left.price_high
  && left.price_high === right.price_high && left.price_low === right.price_low;

/** Pure full readback contract, also used in tests. No page-count-only success is possible. */
export function verifyReadback({ run, order, snapshot, products, prepared, pages, revision, consumer }, expected = {}) {
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  check('run_identity', run?.store === TOKYO_STORE && run.id === expected.runId && run.order_list_import_id === order?.id);
  check('run_completed', run?.status === 'completed' && run.prepare_done_at && run.plan_done_at && run.generate_done_at && run.completed_at && !run.generate_claimed_at && !run.error_message);
  check('import_applied', order?.store === TOKYO_STORE && order.status === 'applied' && order.structural_valid && order.persistence_complete);
  check('snapshot_identity', snapshot?.id === run?.tokyo_snapshot_id && snapshot?.store === TOKYO_STORE
    && snapshot?.order_list_import_id === order?.id && snapshot?.business_date === order?.business_date
    && (!expected.snapshotId || snapshot.id === expected.snapshotId));
  const bySource = new Map(products.map(p => [p.id, p]));
  const byPrepared = new Map(prepared.map(p => [p.id, p]));
  check('products_complete', products.length > 0 && products.length === prepared.length && unique(products.map(p => p.id))
    && unique(prepared.map(p => p.id)) && sameIds(products.map(p => p.id), prepared.map(p => p.source_shinsoku_id))
    && run?.total_prepared === prepared.length);
  check('immutable_prices', prepared.every(p => bySource.has(p.source_shinsoku_id) && samePrices(p, bySource.get(p.source_shinsoku_id))));
  const store = pages.filter(p => p.kind === 'store');
  const postal = pages.filter(p => p.kind === 'postal');
  check('pages_complete', store.length > 0 && postal.length > 0 && pages.length === run?.total_pages
    && store.length + postal.length === pages.length && unique(pages.map(p => p.id))
    && pages.every(p => p.status === 'generated' && p.image_url && p.image_key && !p.error_message));
  const storeIds = store.flatMap(p => p.card_ids ?? []);
  const postalIds = postal.flatMap(p => p.card_ids ?? []);
  check('store_card_identity', unique(storeIds) && storeIds.length > 0 && storeIds.every(id => byPrepared.has(id)));
  const visible = storeIds.map(id => byPrepared.get(id)).filter(Boolean);
  const visibleIds = new Set(storeIds);
  const excluded = prepared.filter(p => !visibleIds.has(p.id));
  check('image_exclusions_reconcile', excluded.length === run?.total_image_ng && visible.length + excluded.length === prepared.length
    && visible.every(p => p.image_url || p.alt_image_url));
  const coverage = snapshot?.report?.oripark_coverage?.items;
  check('oripark_coverage', Array.isArray(coverage) && coverage.length > 0
    && coverage.every(item => visible.some(p => p.source_shinsoku_id === item.productId)));
  check('consumer_identity', consumer?.schemaVersion === 1 && consumer.store === TOKYO_STORE && consumer.runId === run?.id
    && consumer.snapshotId === snapshot?.id && consumer.revision === revision && Number.isSafeInteger(revision) && revision > 0
    && consumer.businessDate === order?.business_date && /^[0-9a-f]{32}$/.test(consumer.fingerprint ?? ''));
  const consumerProducts = Array.isArray(consumer?.products) ? consumer.products : [];
  const activeIds = consumerProducts.map(p => p.sourceId);
  check('consumer_products', sameIds(activeIds, visible.map(p => p.source_shinsoku_id)) && consumerProducts.every(p => {
    const local = visible.find(c => c.source_shinsoku_id === p.sourceId);
    return local && p.priceHigh === local.price_high && p.priceLow === local.price_low && p.name === local.card_name
      && p.franchise === local.franchise && p.modelNumber === local.list_no && p.imageUrl === (local.image_url || local.alt_image_url);
  }));
  check('postal_card_identity', sameIds(postalIds, storeIds));
  check('postal_consumer_version', postal.every(p => p.peleka_snapshot?.runId === run?.id
    && p.peleka_snapshot.snapshotId === snapshot?.id && p.peleka_snapshot.revision === revision
    && p.peleka_snapshot.fingerprint === consumer?.fingerprint));
  return { ok: checks.every(c => c.ok), runId: run?.id, snapshotId: snapshot?.id, checks,
    counts: { products: products.length, prepared: prepared.length, published: visible.length, excluded: excluded.length, storePages: store.length, postalPages: postal.length },
    excluded: excluded.map(p => ({ sourceId: p.source_shinsoku_id, franchise: p.franchise, reason: p.image_url || p.alt_image_url ? 'image_not_renderable' : 'image_missing' })) };
}

/** Read-only, verifies latest same-day run, both published page sets and the authenticated consumer. */
export async function verify(expected, overrides = {}) {
  if (!UUID.test(expected?.runId ?? '')) fail('INVALID_RUN_ID');
  const d = dependencies(overrides);
  const run = await runById(d.db, expected.runId);
  if (!run) fail('RUN_NOT_FOUND');
  const { order, latest } = await latestContext(d, run.order_list_import_id);
  if (latest?.id !== run.id) fail('RUN_SUPERSEDED');
  if (!UUID.test(run.tokyo_snapshot_id ?? '')) fail('SNAPSHOT_MISSING');
  const [snapshot, products, prepared, pages, catalogRevision] = await Promise.all([
    one(d.db, 'tokyo_buyback_snapshot', { id: `eq.${run.tokyo_snapshot_id}`, store: `eq.${TOKYO_STORE}` }, 'id,store,order_list_import_id,business_date,report'),
    d.db.rows('tokyo_buyback_product', { snapshot_id: `eq.${run.tokyo_snapshot_id}` }, 'id,price_high,price_low'),
    d.db.rows('prepared_card', { run_id: `eq.${run.id}` }, 'id,source_shinsoku_id,franchise,card_name,list_no,grade,image_url,alt_image_url,price_high,price_low'),
    d.db.rows('generated_page', { run_id: `eq.${run.id}` }, 'id,kind,status,card_ids,image_key,image_url,error_message,peleka_snapshot'),
    one(d.db, 'tokyo_peleka_catalog_revisions', { run_id: `eq.${run.id}` }, 'run_id,last_revision', 'run_id.asc'),
  ]);
  const revision = catalogRevision?.last_revision;
  if (!Number.isSafeInteger(revision) || revision < 1) fail('CONSUMER_REVISION_MISSING');
  const consumer = await d.consumer(run.id, revision);
  const result = verifyReadback({ run, order, snapshot, products, prepared, pages, revision, consumer }, expected);
  const after = await latestContext(d, order.id);
  if (after.latest?.id !== run.id || after.latest.tokyo_snapshot_id !== run.tokyo_snapshot_id
    || after.latest.status !== 'completed' || after.latest.generate_claimed_at || after.latest.error_message
    || after.latest.generate_done_at !== run.generate_done_at || after.order.status !== 'applied') fail('READBACK_CHANGED');
  const confirmedConsumer = await d.consumer(run.id, revision);
  if (confirmedConsumer?.runId !== consumer.runId || confirmedConsumer?.snapshotId !== consumer.snapshotId
    || confirmedConsumer?.revision !== consumer.revision || confirmedConsumer?.fingerprint !== consumer.fingerprint) fail('CONSUMER_CHANGED');
  return result;
}

/** Resuming the same incident always uses the same queue UUID. No direct run/import status edits. */
export async function recover(incident, overrides = {}) {
  const d = dependencies(overrides);
  let { order, latest, original } = await incidentContext(incident, d, true);
  const requestId = recoveryRequestId(incident.fingerprint);
  const syncStage = observedStage(original) === 'sync';
  const requestFingerprint = sha256({ mappings: [], new_cards: [], exclusions: [], allow_unresolved: order.confirmation_allow_unresolved });
  if (latest.id !== original.id && (!syncStage || latest.order_list_sync_request_id !== requestId)) fail('RUN_SUPERSEDED');
  if (original.status !== 'failed' && latest.id === original.id && original.status !== 'running' && !original.generate_done_at) fail('INCIDENT_NOT_FAILED');
  let targetId = syncStage && latest.id !== original.id ? latest.id : (syncStage ? null : original.id);
  const started = d.now().getTime();
  let launchPending = false;
  if (syncStage && !targetId) {
    if (original.status !== 'failed') fail('SYNC_STILL_RUNNING');
    if (typeof order.confirmation_allow_unresolved !== 'boolean') fail('CONFIRMATION_MISSING');
    const queued = await d.db.rpc('queue_order_list_import_resync', {
      p_import_id: order.id, p_request_id: requestId, p_request_fingerprint: requestFingerprint,
      p_mappings: [], p_new_cards: [], p_exclusions: [], p_allow_unresolved: order.confirmation_allow_unresolved,
    });
    if (queued.request_id !== requestId || queued.import_id !== order.id || queued.request_fingerprint !== requestFingerprint) fail('QUEUE_OWNERSHIP_MISMATCH');
    if (queued.action === 'start_job' && queued.launch_claimed_at) {
      try { await d.launch('sync', { STORE_NAME: TOKYO_STORE, ORDER_LIST_IMPORT_ID: order.id,
        ORDER_LIST_SYNC_REQUEST_ID: requestId, ORDER_LIST_SYNC_REQUEST_FINGERPRINT: requestFingerprint, TRIGGER: 'tokyo-repair' }); }
      catch (error) { if (error.code !== 'LAUNCH_RESULT_UNKNOWN') throw error; launchPending = true; }
    } else if (queued.action !== 'noop') fail('QUEUE_ACTION_INVALID');
    targetId = queued.run_id ?? null;
  }
  let generationRequested = false;
  while (d.now().getTime() - started < d.timeoutMs) {
    const current = await latestContext(d, order.id);
    latest = current.latest;
    if (syncStage && latest?.order_list_sync_request_id === requestId) {
      if (latest.order_list_sync_request_fingerprint !== requestFingerprint) fail('QUEUE_OWNERSHIP_MISMATCH');
      targetId = latest.id;
    }
    if (targetId && latest?.id !== targetId) fail('RUN_SUPERSEDED');
    if (!targetId && latest?.id !== original.id) fail('RUN_SUPERSEDED');
    if (targetId) {
      if (latest.status === 'failed' && (syncStage || generationRequested)) fail(observedStage(latest) === 'generate' ? 'GENERATION_FAILED' : 'SYNC_FAILED');
      if (latest.generate_done_at) {
        if (syncStage && (!latest.tokyo_snapshot_id || latest.tokyo_snapshot_id === incident.snapshotId)) fail('SNAPSHOT_NOT_REPLACED');
        const result = await verify({ runId: targetId, snapshotId: latest.tokyo_snapshot_id }, overrides);
        if (!result.ok) fail('ACCEPTANCE_FAILED', result.checks.filter(c => !c.ok).map(c => c.name).join(','));
        return { ...result, originalRunId: incident.runId, originalSnapshotId: incident.snapshotId ?? null, requestId: syncStage ? requestId : null };
      }
      if (latest.plan_done_at && latest.prepare_done_at && !generationRequested) {
        if (syncStage && (!latest.tokyo_snapshot_id || latest.tokyo_snapshot_id === incident.snapshotId)) fail('SNAPSHOT_NOT_REPLACED');
        const freshClaim = latest.status === 'running' && latest.generate_claimed_at
          && d.now().getTime() - Date.parse(latest.generate_claimed_at) < 75 * 60 * 1000;
        if (!freshClaim) {
          // Same fencing conditions as watchdog, restricted to this exact latest run.
          const claimedAt = d.now();
          const token = await d.db.claimGenerate(latest, claimedAt);
          if (token) {
            try {
              const fenced = await latestContext(d, order.id);
              if (fenced.latest?.id !== targetId || fenced.latest.tokyo_snapshot_id !== latest.tokyo_snapshot_id) fail('RUN_SUPERSEDED');
            } catch (error) {
              await d.db.releaseUnstartedGenerate(latest, token, claimedAt);
              throw error;
            }
            generationRequested = true;
            try { await d.launch('generate', { STORE_NAME: TOKYO_STORE, RUN_ID: targetId, GENERATE_CLAIM_TOKEN: token, TRIGGER: 'tokyo-repair' }); }
            catch (error) { if (error.code !== 'LAUNCH_RESULT_UNKNOWN') throw error; launchPending = true; }
          }
        }
      }
    }
    await d.sleep(d.pollMs);
  }
  fail(launchPending ? 'LAUNCH_PENDING_TIMEOUT' : 'RECOVERY_TIMEOUT');
}
