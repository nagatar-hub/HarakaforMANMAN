import { accessToken, google, jobName, json, readObject, stateBucket, writeObject } from './cloud.mjs';
import { detect, STORE, SUPABASE_ORIGIN } from './detect.mjs';

export const SHEET_LOG_VIEW = 'projects/spectre-tomstocks-20260227/locations/global/buckets/_Default/views/haraka-tokyo-repair';
const JOB = 'haraka-manman-akihabara-generate';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const EXECUTION = /^projects\/(?:spectre-tomstocks-20260227|569936489397)\/locations\/asia-northeast1\/jobs\/haraka-manman-akihabara-generate\/executions\/haraka-manman-akihabara-generate-[a-z0-9-]+$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validate(incident, attempt) {
  if (!incident || incident.store !== STORE || incident.stage !== 'generate'
    || !UUID.test(incident.runId ?? '') || !UUID.test(incident.importId ?? '') || !UUID.test(incident.snapshotId ?? '')
    || !UUID.test(attempt ?? '') || !HASH.test(incident.fingerprint ?? '')
    || incident.diagnostic?.code !== 'sheet_publish_failed' || incident.diagnostic.failedPageCount !== 0
    || incident.diagnostic.sheetFailure !== true) fail('SHEET_INVALID_INCIDENT');
}

function defaults(env = process.env) {
  const rows = async (table, parameters) => {
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (env.SUPABASE_URL !== SUPABASE_ORIGIN || !key || env.STORE_NAME !== STORE) fail('SHEET_DATABASE_CONFIGURATION');
    let response;
    try { response = await fetch(`${SUPABASE_ORIGIN}/rest/v1/${table}?${new URLSearchParams(parameters)}`, {
      headers: { apikey: key, ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` }) },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    }); } catch { fail('SHEET_DATABASE_READ_FAILED'); }
    if (!response.ok) fail('SHEET_DATABASE_READ_FAILED');
    const value = await response.json();
    if (!Array.isArray(value)) fail('SHEET_DATABASE_READ_FAILED');
    return value;
  };
  return {
    now: Date.now, sleep: delay, pollMs: 3000, pollLimit: 40,
    async current(incident) {
      const [order] = await rows('order_list_import', { select: 'id,store,business_date,structural_valid,persistence_complete',
        store: `eq.${STORE}`, order: 'business_date.desc,created_at.desc,id.desc', limit: '1' });
      if (!order || order.id !== incident.importId || order.store !== STORE || order.business_date !== incident.businessDate
        || !order.structural_valid || !order.persistence_complete) return false;
      const runs = await rows('run', { select: 'id,store,status,order_list_import_id,tokyo_snapshot_id,generate_done_at',
        store: `eq.${STORE}`, order_list_import_id: `eq.${order.id}`, order: 'started_at.desc,id.desc', limit: '30' });
      const run = runs[0];
      if (!run || runs.some(item => item.status === 'running') || run.id !== incident.runId || run.status !== 'completed'
        || !run.generate_done_at || run.tokyo_snapshot_id !== incident.snapshotId) return false;
      return !(await rows('generated_page', { select: 'id', run_id: `eq.${run.id}`, status: 'eq.failed', limit: '1' })).length;
    },
    async failureCurrent(incident) {
      const latest = await detect({ env, accessToken: await accessToken() });
      return latest?.fingerprint === incident.fingerprint && latest.runId === incident.runId;
    },
    load: key => readObject(stateBucket, key),
    save: (key, value) => writeObject(stateBucket, key, value, '0'),
    async executions(since) {
      const found = [];
      let pageToken;
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ pageSize: '100', ...(pageToken ? { pageToken } : {}) });
        const result = await (await google(`https://run.googleapis.com/v2/${jobName('generate')}/executions?${query}`)).json();
        const rows = result.executions ?? [];
        if (!Array.isArray(rows)) fail('SHEET_EXECUTION_LOOKUP_INVALID');
        found.push(...rows);
        if (!result.nextPageToken || rows.some(row => Date.parse(row.createTime) < since - 300000)) return found;
        pageToken = result.nextPageToken;
      }
      fail('SHEET_EXECUTION_LOOKUP_LIMIT');
    },
    async launch(incident, attempt) {
      await google(`https://run.googleapis.com/v2/${jobName('generate')}:run`, json('POST', { overrides: {
        taskCount: 1, timeout: '300s', containerOverrides: [{ env: [
          { name: 'JOB_NAME', value: 'publish-buyback-sheet' }, { name: 'STORE_NAME', value: STORE },
          { name: 'RUN_ID', value: incident.runId }, { name: 'TOKYO_SHEET_REPAIR_ATTEMPT', value: attempt },
          { name: 'TRIGGER', value: 'tokyo-sheet-repair' },
        ] }],
      } }));
    },
    async getExecution(name) { return (await google(`https://run.googleapis.com/v2/${name}`)).json(); },
    async evidence(execution, runId) {
      const short = execution.name.split('/').at(-1);
      const result = await (await google('https://logging.googleapis.com/v2/entries:list', json('POST', {
        resourceNames: [SHEET_LOG_VIEW], orderBy: 'timestamp desc', pageSize: 20,
        filter: `resource.type="cloud_run_job" AND resource.labels.job_name="${JOB}" AND labels."run.googleapis.com/execution_name"="${short}" AND textPayload:"[buyback-sheet] published: store=${STORE}, run=${runId},"`,
      }))).json();
      return sheetPublicationEvidence(result.entries ?? [], execution, runId);
    },
  };
}

/** Logs are evidence only after the exact execution completed, never an instruction source. */
export function sheetPublicationEvidence(entries, execution, runId) {
  if (!EXECUTION.test(execution?.name ?? '') || !UUID.test(runId ?? '') || !Number.isFinite(Date.parse(execution.createTime))) return null;
  const pattern = new RegExp(`^\\[buyback-sheet\\] published: store=${STORE}, run=${runId}, rows=(0|[1-9][0-9]*), hash=([a-f0-9]{64})$`);
  const short = execution.name.split('/').at(-1);
  for (const entry of entries) {
    if (entry.resource?.labels?.project_id !== 'spectre-tomstocks-20260227' || entry.resource?.labels?.job_name !== JOB || entry.labels?.['run.googleapis.com/execution_name'] !== short
      || !Number.isFinite(Date.parse(entry.timestamp)) || Date.parse(entry.timestamp) < Date.parse(execution.createTime)) continue;
    const match = typeof entry.textPayload === 'string' ? entry.textPayload.match(pattern) : null;
    if (match && Number.isSafeInteger(Number(match[1]))) return { rowCount: Number(match[1]), contentHash: match[2] };
  }
  return null;
}

function matchingExecution(executions, incident, attempt) {
  const matches = executions.filter(execution => {
    const values = execution.template?.containers?.[0]?.env ?? [];
    const get = name => values.find(item => item.name === name)?.value;
    if (get('TOKYO_SHEET_REPAIR_ATTEMPT') !== attempt) return false;
    if (!EXECUTION.test(execution.name ?? '') || get('JOB_NAME') !== 'publish-buyback-sheet'
      || get('RUN_ID') !== incident.runId || get('STORE_NAME') !== STORE) fail('SHEET_EXECUTION_IDENTITY');
    return true;
  });
  if (matches.length > 1) fail('SHEET_DUPLICATE_EXECUTION');
  return matches[0];
}

/** Retry only the existing Sheet publisher. No regeneration, source update or model call. */
export async function repairSheet(incident, options = {}) {
  const { attempt, ...overrides } = options;
  validate(incident, attempt);
  const d = { ...defaults(), ...overrides };
  if (!await d.current(incident)) return { status: 'superseded', runId: incident.runId };
  const key = `sheets/${attempt}.json`;
  let stored = await d.load(key);
  if (stored && (stored.data?.version !== 1 || stored.data.runId !== incident.runId || stored.data.importId !== incident.importId
    || stored.data.snapshotId !== incident.snapshotId || stored.data.attempt !== attempt
    || !Number.isFinite(stored.data.startedAt) || stored.data.startedAt > d.now())) fail('SHEET_INTENT_MISMATCH');
  let execution = matchingExecution(await d.executions(stored?.data.startedAt ?? d.now()), incident, attempt);
  if (!execution) {
    if (!await d.failureCurrent(incident) || !await d.current(incident)) return { status: 'superseded', runId: incident.runId };
    // Persist before the external launch. A lost response never authorizes a second launch.
    if (stored) fail('SHEET_LAUNCH_UNCERTAIN');
    const intent = { version: 1, runId: incident.runId, importId: incident.importId, snapshotId: incident.snapshotId, attempt, startedAt: d.now() };
    try { await d.save(key, intent); }
    catch (error) { if (error.status === 412) fail('SHEET_LAUNCH_UNCERTAIN'); throw error; }
    stored = { data: intent };
    try { await d.launch(incident, attempt); }
    catch (error) { if (error.status >= 400 && error.status < 500) fail('SHEET_LAUNCH_REJECTED'); fail('SHEET_LAUNCH_UNCERTAIN'); }
  }
  for (let poll = 0; poll < d.pollLimit; poll++) {
    execution = execution ? await d.getExecution(execution.name)
      : matchingExecution(await d.executions(stored.data.startedAt), incident, attempt);
    if (execution) {
      if (!matchingExecution([execution], incident, attempt)) fail('SHEET_EXECUTION_IDENTITY');
      if (Number(execution.failedCount) > 0 || execution.conditions?.some(condition => condition.type === 'Completed' && condition.state === 'CONDITION_FAILED')) fail('SHEET_EXECUTION_FAILED');
      if (execution.completionTime && Number(execution.succeededCount) === 1) {
        const evidence = await d.evidence(execution, incident.runId);
        if (evidence) {
          if (!await d.current(incident)) return { status: 'superseded', runId: incident.runId };
          return { status: 'completed', runId: incident.runId, executionName: execution.name, ...evidence };
        }
        if (d.now() - Date.parse(execution.completionTime) > 90000) fail('SHEET_PUBLICATION_UNCONFIRMED');
      }
    }
    await d.sleep(d.pollMs);
  }
  fail('SHEET_LAUNCH_UNCERTAIN');
}
