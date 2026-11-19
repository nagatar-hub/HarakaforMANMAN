import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDiagnostic, runController } from './controller.mjs';
import { imageRepo } from './cloud.mjs';

const base = 'a'.repeat(40), sha = 'b'.repeat(40), digest = 'sha256:'+'c'.repeat(64);
const initial = { image: imageRepo+'@sha256:'+'d'.repeat(64), revision: base };
const incident = { store: 'manman-akihabara', fingerprint: 'e'.repeat(64), runId:'run', importId:'order', snapshotId:null, stage:'sync',
  diagnostic:{code:'unknown', errorType:'Error', fileHints:['private input']} };

function harness() {
  let stored, head = base, runtime = initial;
  const calls = [], artifacts = new Map();
  const deps = {
    load: async () => structuredClone(stored),
    save: async (data, gen) => {
      assert.equal(gen, stored?.generation ?? '0');
      const generation = String(Number(gen)+1);
      stored = { data: structuredClone(data), generation };
      return generation;
    },
    now: () => Date.parse('2026-11-19T06:00:00Z'), uuid: () => 'attempt',
    detect: async () => incident, modelReady: async () => true, capture: async () => ({input:{ products:[{}] },inputSha256:'input',errorSha256:'error'}),
    archive: async (key, data) => { artifacts.set(key,data); }, artifact: async key => artifacts.get(key),
    sourceHead: async () => head, runtime: async () => runtime,
    assertDeployedSource: async (src, prev) => { assert.equal(src,base); assert.equal(prev,base); },
    build: async (spec, phase) => {
      calls.push(phase);
      if (phase === 'propose') artifacts.set('proposals/attempt.json',{base,stage:'sync',decision:'repair'});
      else artifacts.set('verified/attempt/tree.json',{base,stage:'sync',files:['verified']});
      return {digest};
    },
    publish: async spec => { calls.push('publish'); assert.deepEqual(spec.verified.files,['verified']); head = sha; return sha; },
    changeImage: async (_stage, prev, next, prevRev, nextRev) => {
      calls.push(nextRev === sha ? 'deploy' : 'rollback');
      assert.deepEqual(runtime,{image:prev,revision:prevRev});
      runtime = {image:next,revision:nextRev};
    },
    recover: async () => { calls.push('regenerate/readback'); return {ok:true,runId:'new',snapshotId:'new-snapshot',counts:{pages:2}}; },
    rollbackSource: async ({sha:bad}) => { calls.push('revert'); assert.equal(head,bad); head='reverted'; },
  };
  return {deps,calls,artifacts,get ledger(){return stored?.data}, seed(data){stored={generation:'1',data:structuredClone(data)}}};
}

test('one failure verifies once, publishes the verified image and reads back the regenerated run', async () => {
  const h=harness();
  assert.equal((await runController(h.deps)).status,'repaired');
  assert.deepEqual(h.calls,['propose','verify','publish','deploy','regenerate/readback']);
  assert.equal(h.ledger.history[0].resultRunId,'new');
  assert.equal((await runController(h.deps)).status,'already_handled');
});
test('healthy, overlapping executions and a race claiming the lease do no work',async () => {
  const h=harness();
  assert.equal((await runController({...h.deps,detect:async()=>null})).status,'healthy');
  assert.equal((await runController({...h.deps,save:async()=>{throw Object.assign(Error(),{status:412})}})).status,'in_progress');
  h.seed({version:1,history:[],active:{expires:h.deps.now()+1}});
  assert.equal((await runController(h.deps)).status,'in_progress');
  assert.deepEqual(h.calls,[]);
});
test('a missing fixture may be diagnosed, and cannot advance to a release build',async () => {
  const h=harness();
  const result=await runController({...h.deps,capture:async()=>{throw Object.assign(Error(),{code:'FIXTURE_UNAVAILABLE'})}});
  assert.equal(result.reason,'NO_REPRODUCIBLE_FIXTURE');assert.deepEqual(h.calls,['propose']);
});
test('an empty model secret leaves a pending incident eligible for the following scheduled run',async () => {
  const h=harness();
  assert.equal((await runController({...h.deps,modelReady:async()=>false})).status,'waiting_for_model_key');
  assert.equal(h.ledger,undefined);
  assert.equal((await runController(h.deps)).status,'repaired');
});
test('a sheet-only failure republishes that run once without a model, CI, or regeneration',async()=>{
  const h=harness(), stranded={...incident,stage:'generate',diagnostic:{code:'sheet_publish_failed',sheetFailure:true,failedPageCount:0}};
  const deps={...h.deps,detect:async()=>stranded, modelReady:async()=>{throw Error('unneeded')},
    repairSheet:async(value)=>{h.calls.push('sheet');return {status:'completed',runId:value.runId,rowCount:40,contentHash:'f'.repeat(64)}}};
  assert.equal((await runController(deps)).status,'sheet_republished');
  assert.equal((await runController(deps)).status,'already_handled');
  assert.deepEqual(h.calls,['sheet']);
});
test('a superseded run cannot change source or production',async () => {
  const h=harness();let reads=0;
  assert.equal((await runController({...h.deps,detect:async()=>++reads===1?incident:null})).status,'superseded');
  assert.deepEqual(h.calls,['propose','verify']);
});
test('a failed private replay cannot publish or deploy',async () => {
  const h=harness();
  const result=await runController({...h.deps,build:async (spec,phase)=>{
    if(phase==='verify')throw Error('REPLAY_FAILED');return h.deps.build(spec,phase);
  }});
  assert.equal(result.reason,'REPLAY_FAILED');assert.deepEqual(h.calls,['propose']);
});
test('unsuccessful regeneration restores the previous image and compensates the source commit',async () => {
  const h=harness();
  const result=await runController({...h.deps,recover:async()=>({ok:false})});
  assert.equal(result.status,'rolled_back');assert.deepEqual(h.calls.slice(-3),['deploy','rollback','revert']);
  assert.equal(h.ledger.history[0].previous.image,initial.image);
});
test('a restarted controller resumes an already deployed release without rerunning Codex or CI',async () => {
  const h=harness();
  h.seed({version:1,history:[],active:{expires:0,phase:'deploying',incident,attempt:'attempt',previous:initial,sha,base,digest:imageRepo+'@'+digest}});
  const result=await runController({...h.deps,runtime:async()=>({image:imageRepo+'@'+digest,revision:sha}),detect:async()=>null});
  assert.equal(result.status,'repaired');assert.deepEqual(h.calls,['regenerate/readback']);
});
test('a lost journal write after a successful production change does not trigger speculation or rollback',async()=>{
  const h=harness();
  await assert.rejects(runController({...h.deps,save:async(data,gen)=>{
    if (data.active?.phase==='regenerating') throw Error('storage response lost');
    return h.deps.save(data,gen);
  }}),/storage response lost/);
  assert.deepEqual(h.calls,['propose','verify','publish','deploy']);
  assert.equal(h.ledger.active.phase,'deploying');
});
test('an indeterminate image update defers the release decision until its state can be read',async()=>{
  const h=harness();
  const result=await runController({...h.deps,changeImage:async()=>{throw Error('Job update outcome unknown')}});
  assert.equal(result.status,'retry_scheduled');
  assert.equal(h.ledger.active.phase,'deploying');
  assert.ok(!h.calls.includes('revert'));
});
test('the model receives source coordinates and counts without row values or external messages',()=>{
  const result=publicDiagnostic({...incident,diagnostic:{code:'private value',errorType:'sensitive'}},{site:{module:'lib/oripark-coverage',line:12,secret:'private'},input:{products:[{name:'private'}]}});
  assert.equal(result.code,'unknown');assert.equal(result.site.line,12);assert.equal(result.products,1);assert.ok(!JSON.stringify(result).includes('private'));
});
