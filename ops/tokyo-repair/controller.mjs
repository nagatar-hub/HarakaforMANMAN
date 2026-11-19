import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, build, changeImage, dataBucket, google, imageRepo, job, readObject, secret, stateBucket, writeObject } from './cloud.mjs';
import { detect, STORE } from './detect.mjs';
import { captureReplayFixture, recover, verify } from './recovery.mjs';
import { sourceHead, assertDeployedSource, publish, rollbackSource, checkSourceAccess } from './source.mjs';
import { repairSheet } from './sheet.mjs';
import { structuralDiagnostic } from './diagnostic.mjs';

const stateKey = 'controller/tokyo.json';
const leaseMs = 200 * 60000; // Longer than the three-hour, zero-retry Cloud Run task.
const defaults = {
  load: () => readObject(stateBucket, stateKey),
  save: (value, generation) => writeObject(stateBucket, stateKey, value, generation),
  detect: async () => detect({ accessToken: await accessToken() }),
  capture: captureReplayFixture, recover, repairSheet, build, sourceHead, assertDeployedSource, publish, rollbackSource, changeImage,
  artifact: async key => (await readObject(dataBucket, key))?.data,
  archive: (key, fixture) => writeObject(dataBucket, key, fixture),
  modelReady: async () => {
    try { return (await (await google('https://secretmanager.googleapis.com/v1/'+secret)).json()).state === 'ENABLED'; }
    catch (error) { if (error.status === 404) return false; throw error; }
  },
  runtime: async stage => {
    const current = await job(stage);
    if (current.reconciling || (current.observedGeneration && current.generation !== current.observedGeneration)) throw Error('RUNTIME_RECONCILING');
    const container = current.template.template.containers[0];
    const revision = container.env.find(item => item.name === 'TOKYO_REPAIR_SOURCE_REVISION')?.value;
    if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !container.image.startsWith(imageRepo+'@sha256:')) throw Error('UNBOUND_RUNTIME');
    return { image: container.image, revision };
  },
  now: Date.now, uuid: randomUUID,
};

const count = rows => Array.isArray(rows) ? rows.length : 0;
export function publicDiagnostic(incident, fixture) {
  const input = fixture?.input ?? {}, d = incident.diagnostic;
  // The model only sees repository constants, bounded counts and trusted stack coordinates.
  const diagnostic = { code: /^(?:page_)?(?:unknown|coverage_image_ambiguous|coverage_identity_ambiguous|coverage_source_invalid|coverage_missing|source_stale|dependency_auth|rate_limit|network|sheet_publish_failed)$/.test(d.code) ? d.code : 'unknown',
    errorType: ['Error', 'TypeError', 'ReferenceError'].includes(d.errorType) ? d.errorType : 'Error',
    products: count(input.preCoverage?.products ?? input.products), coverage: count(input.baseline?.cards ?? input.snapshot?.report?.oripark_coverage?.items),
    mappings: count(input.imageMappings), cards: count(input.cards), layouts: count(input.layouts), fixtureAvailable: Boolean(fixture) };
  if (fixture) {
    diagnostic.structure = structuralDiagnostic(fixture);
    if (diagnostic.structure.site) diagnostic.site = diagnostic.structure.site;
  }
  return diagnostic;
}

function safeReason(error) {
  if (/^[A-Z][A-Z_0-9]{2,80}$/.test(error?.code ?? '')) return error.code;
  if (/^(?:[A-Z][A-Z_0-9]{2,80}|(?:propose|verify) build [a-f0-9-]{36} [A-Z_]+)$/.test(error?.message ?? '')) return error.message;
  return 'REPAIR_STEP_FAILED';
}

export async function runController(overrides = {}) {
  const d = { ...defaults, ...overrides };
  const stored = await d.load();
  let generation = stored?.generation ?? '0';
  const ledger = stored?.data ?? { version: 1, history: [] };
  if (ledger.version !== 1 || !Array.isArray(ledger.history)) throw Error('INVALID_LEDGER');
  const save = async () => {
    try { generation = await d.save(ledger, generation); }
    catch (error) { error.journalWrite = true; throw error; }
  };
  let a = ledger.active;
  if (a && a.expires > d.now()) return { status: 'in_progress' };
  if (!a) {
    const incident = await d.detect();
    if (!incident) return { status: 'healthy' };
    if (ledger.history.some(h => h.fingerprint === incident.fingerprint &&
      (!['superseded','sheet_republished'].includes(h.status) || h.runId === incident.runId))) return { status: 'already_handled' };
    const sheetOnly = incident.stage === 'generate' && incident.diagnostic.code === 'sheet_publish_failed'
      && incident.diagnostic.sheetFailure && incident.diagnostic.failedPageCount === 0;
    if (!sheetOnly && !await d.modelReady()) return { status: 'waiting_for_model_key', runId: incident.runId };
    a = { incident, attempt: d.uuid(), startedAt: new Date(d.now()).toISOString(), phase: sheetOnly ? 'sheet' : 'capture' };
    ledger.active = a;
  }
  a.expires = d.now() + leaseMs;
  try { await save(); } catch (error) { if (error.status === 412) return { status: 'in_progress' }; throw error; }

  const { incident, attempt } = a;
  const siblingStage = incident.stage === 'sync' ? 'generate' : 'sync';
  const testedRevision = (stage, live) => {
    const accepted = ledger.compatible?.[stage];
    return accepted?.image === live.image && accepted.revision === live.revision ? accepted.testedThrough : live.revision;
  };
  const advance = async phase => { a.phase = phase; await save(); };
  const finish = async (status, reason, result) => {
    ledger.history = ledger.history.filter(h => d.now() - h.at < 3 * 86400000);
    ledger.history.push({ fingerprint: incident.fingerprint, runId: incident.runId, attempt, at: d.now(),
      status, phase: a.phase, reason, base: a.base, sha: a.sha, digest: a.digest, previous: a.previous,
      resultRunId: result?.runId, snapshotId: result?.snapshotId, counts: result?.counts });
    delete ledger.active;
    await save();
    return { status, reason, attempt, runId: result?.runId, counts: result?.counts };
  };
  const exactFailure = async () => {
    const current = await d.detect();
    return current?.fingerprint === incident.fingerprint && current?.runId === incident.runId
      && current?.importId === incident.importId && current?.snapshotId === incident.snapshotId;
  };
  const releaseInputs = async () => {
    const [proposal, verified] = await Promise.all([d.artifact('proposals/'+attempt+'.json'), d.artifact('verified/'+attempt+'/tree.json')]);
    if (!proposal || !verified || verified.base !== a.base || verified.stage !== incident.stage) throw Error('INVALID_RELEASE_ARTIFACT');
    return { attempt, base: a.base, stage: incident.stage, createdAt: a.startedAt, proposal, verified };
  };

  try {
    if (a.phase === 'sheet') {
      const result = await d.repairSheet(incident, { attempt });
      if (result.status === 'superseded') return await finish('superseded','INCIDENT_CHANGED');
      if (result.status !== 'completed' || result.runId !== incident.runId || !Number.isSafeInteger(result.rowCount)
        || result.rowCount < 1 || !/^[a-f0-9]{64}$/.test(result.contentHash ?? '')) throw Error('SHEET_READBACK_FAILED');
      return await finish('sheet_republished',undefined,{runId:result.runId,counts:{rows:result.rowCount},snapshotId:incident.snapshotId});
    }
    if (a.phase === 'capture') {
      a.base = await d.sourceHead();
      a.previous = await d.runtime(incident.stage);
      await d.assertDeployedSource(a.base, testedRevision(incident.stage, a.previous));
      // Remember the untouched sibling only when its source was compatible with this verified build.
      try {
        const sibling = await d.runtime(siblingStage);
        await d.assertDeployedSource(a.base, testedRevision(siblingStage, sibling));
        a.sibling = sibling;
      } catch { /* Independently deployed sibling continues to require its own baseline. */ }
      let fixture;
      try { fixture = await d.capture(incident); }
      catch (e) {
        if (!['FIXTURE_UNAVAILABLE','INCIDENT_NOT_CURRENT_FAILURE','FAILURE_STAGE_CHANGED','UNKNOWN_FAILURE_STAGE'].includes(e.code)) throw e;
      }
      a.diagnostic = publicDiagnostic(incident, fixture);
      if (fixture) {
        a.fixtureKey = 'tokyo-repair-fixtures/attempts/'+attempt+'.json';
        // An interrupted create may already have written the immutable replay input.
        const existing = await d.artifact(a.fixtureKey);
        if (existing) {
          if (existing.incidentFingerprint !== incident.fingerprint || existing.inputSha256 !== fixture.inputSha256 || existing.errorSha256 !== fixture.errorSha256) throw Error('FIXTURE_CHANGED');
        } else await d.archive(a.fixtureKey, fixture);
      }
      await advance('propose');
    }
    const spec = { attempt, base: a.base, stage: incident.stage, diagnostic: a.diagnostic, fixtureKey: a.fixtureKey };
    if (a.phase === 'propose') {
      if (!await d.artifact('proposals/'+attempt+'.json')) await d.build(spec, 'propose');
      const proposal = await d.artifact('proposals/'+attempt+'.json');
      if (proposal?.base !== a.base || proposal.stage !== incident.stage) throw Error('INVALID_PROPOSAL');
      if (!a.fixtureKey || proposal.decision !== 'repair') return await finish('needs_review', a.fixtureKey ? 'INSUFFICIENT_EVIDENCE' : 'NO_REPRODUCIBLE_FIXTURE');
      await advance('verify');
    }
    if (a.phase === 'verify') {
      const checked = await d.build(spec, 'verify');
      if (!/^sha256:[0-9a-f]{64}$/.test(checked.digest ?? '')) throw Error('UNVERIFIED_IMAGE');
      a.digest = imageRepo+'@'+checked.digest;
      if (!await exactFailure()) return await finish('superseded','INCIDENT_CHANGED');
      await advance('publishing');
    }
    if (a.phase === 'publishing') {
      // publish is deterministic on retry and uses a normal fast-forward push.
      a.sha = await d.publish(await releaseInputs());
      if (!/^[a-f0-9]{40}$/.test(a.sha ?? '')) throw Error('INVALID_RELEASE_COMMIT');
      await advance('deploying');
    }
    if (a.phase === 'deploying') {
      const current = await d.runtime(incident.stage);
      if (current.image !== a.digest || current.revision !== a.sha) {
        if (!await exactFailure()) throw Error('INCIDENT_CHANGED');
        if (await d.sourceHead() !== a.sha) throw Error('SOURCE_HEAD_CHANGED');
        await d.changeImage(incident.stage, a.previous.image, a.digest, a.previous.revision, a.sha);
      }
      await advance('regenerating');
    }
    if (a.phase === 'regenerating') {
      const current = await d.runtime(incident.stage);
      if (current.image !== a.digest || current.revision !== a.sha) throw Error('RUNTIME_CHANGED');
      const result = await d.recover(incident);
      if (!result?.ok) throw Error('ACCEPTANCE_FAILED');
      if (a.sibling) {
        ledger.compatible ??= {};
        ledger.compatible[siblingStage] = { ...a.sibling, testedThrough:a.sha };
      }
      return await finish('repaired', undefined, result);
    }
  } catch (e) {
    if (e.journalWrite || e.status === 412) throw e;
    if (a.phase === 'sheet' && (e.code === 'SHEET_LAUNCH_UNCERTAIN' || e.message === 'SHEET_LAUNCH_UNCERTAIN') && (a.retries ?? 0) < 3) {
      a.retries = (a.retries ?? 0) + 1;
      a.expires = d.now()+90000;
      await save();
      return { status:'retry_scheduled', phase:'sheet' };
    }
    if (a.phase === 'deploying' && (e.message === 'Job update outcome unknown' || e.message === 'RUNTIME_RECONCILING'
      || e.name === 'TimeoutError' || e.message === 'fetch failed' || e.status >= 500)) {
      // Re-read the immutable image and source on the next tick before deciding on compensation.
      if ((a.updateChecks ?? 0) >= 3) return await finish('rollback_needs_review','UPDATE_OUTCOME_UNCERTAIN');
      a.updateChecks = (a.updateChecks ?? 0) + 1;
      a.expires = d.now() + 60000;
      await save();
      return { status:'retry_scheduled', phase:a.phase };
    }
    if (!a.sha) {
      // A timeout or temporary infrastructure failure must not consume the incident forever.
      if ((a.retries ?? 0) < 2 && (e.status >= 500 || e.status === 429 || e.code === 'REMOTE_READ_FAILED'
        || a.phase === 'publishing' || /^(propose|verify) build .* (TIMEOUT|INTERNAL_ERROR|EXPIRED)$/.test(e.message))) {
        a.retries = (a.retries ?? 0) + 1;
        a.expires = d.now() + 60000;
        await save();
        return { status: 'retry_scheduled', phase: a.phase };
      }
      return await finish('needs_review', safeReason(e));
    }
    a.reason = safeReason(e);
    await advance('rolling_back');
  }
  if (a.phase !== 'rolling_back') throw Error('INVALID_PHASE');
  try {
    const current = await d.runtime(incident.stage);
    if (current.image === a.digest && current.revision === a.sha) {
      await d.changeImage(incident.stage, a.digest, a.previous.image, a.sha, a.previous.revision);
    } else if (current.image !== a.previous.image || current.revision !== a.previous.revision) throw Error('ROLLBACK_CONFLICT');
    await d.rollbackSource({ base: a.base, sha: a.sha });
  } catch (e) {
    return await finish('rollback_needs_review', safeReason(e));
  }
  return await finish('rolled_back', a.reason);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.STORE_NAME !== STORE) throw Error('WRONG_TENANT');
    const [action, runId] = process.argv.slice(2);
    let result;
    if (action === '--readback') {
      const checked = await verify({ runId });
      result = { ok:checked.ok, runId:checked.runId, snapshotId:checked.snapshotId, counts:checked.counts, checks:checked.checks };
    }
    else if (action === '--detect-only') result = { status: await defaults.detect() ? 'incident' : 'healthy' };
    else if (action === '--readiness') {
      const [head, sync, generate, modelReady] = await Promise.all([
        defaults.sourceHead(), defaults.runtime('sync'), defaults.runtime('generate'), defaults.modelReady(),
      ]);
      await Promise.all([sync, generate].map(bound => defaults.assertDeployedSource(head, bound.revision)));
      const sourceWritable = await checkSourceAccess();
      result = { status:'ready', source:head, sync:sync.revision, generate:generate.revision, modelReady, sourceWritable };
    }
    else if (!action) result = await runController();
    else throw Error('UNKNOWN_COMMAND');
    console.log(JSON.stringify(result));
    if (result.ok === false || ['waiting_for_model_key','needs_review','rollback_needs_review','rolled_back'].includes(result.status)) process.exitCode = 1;
  } catch (error) { console.error(safeReason(error)); process.exitCode = 1; }
}
