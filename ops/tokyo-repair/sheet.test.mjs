import test from 'node:test';
import assert from 'node:assert/strict';
import { repairSheet, sheetPublicationEvidence } from './sheet.mjs';

const runId='11111111-1111-4111-8111-111111111111';
const importId='22222222-2222-4222-8222-222222222222';
const snapshotId='33333333-3333-4333-8333-333333333333';
const attempt='44444444-4444-4444-8444-444444444444';
const now=Date.parse('2026-11-19T06:00:00Z');
const hash='a'.repeat(64);
const incident={store:'manman-akihabara',stage:'generate',runId,importId,snapshotId,attempt,fingerprint:'b'.repeat(64),businessDate:'2026-11-19',diagnostic:{code:'sheet_publish_failed',failedPageCount:0,sheetFailure:true}};
const name='projects/spectre-tomstocks-20260227/locations/asia-northeast1/jobs/haraka-manman-akihabara-generate/executions/haraka-manman-akihabara-generate-abcde';
const intent={version:1,runId,importId,snapshotId,attempt,startedAt:now-5000};
function execution(extra={}) {
  return {name,createTime:new Date(now-5000).toISOString(),completionTime:new Date(now-1000).toISOString(),succeededCount:1,failedCount:0,
    template:{containers:[{env:[{name:'JOB_NAME',value:'publish-buyback-sheet'},{name:'STORE_NAME',value:incident.store},{name:'RUN_ID',value:runId},{name:'TOKYO_SHEET_REPAIR_ATTEMPT',value:attempt}]}]},...extra};
}
function fixture(extra={}) {
  const state={stored:null,executions:[],launches:0,saves:0,events:[]};
  const options={attempt,now:()=>now,pollMs:0,pollLimit:2,sleep:async()=>{},
    current:async()=>true,failureCurrent:async()=>true,
    load:async()=>state.stored,save:async(key,value)=>{state.saves++;state.events.push('save');state.stored={data:value};},
    executions:async()=>state.executions,
    launch:async()=>{state.launches++;state.events.push('launch');state.executions=[execution()];},
    getExecution:async()=>state.executions[0],evidence:async()=>({rowCount:1633,contentHash:hash}),...extra};
  return {state,options};
}
const rejects=(operation,code)=>assert.rejects(operation,error=>error.code===code);

test('sheet-only launch records intent first and returns exact run evidence',async()=>{
  const {state,options}=fixture();const result=await repairSheet(incident,options);
  assert.deepEqual(state.events,['save','launch']);assert.equal(state.launches,1);
  assert.deepEqual(result,{status:'completed',runId,executionName:name,rowCount:1633,contentHash:hash});
});
test('foreign store, non-sheet failure and failed pages never launch',async()=>{
  for(const altered of [{store:'oripark'},{stage:'sync'},{snapshotId:null},{diagnostic:{...incident.diagnostic,failedPageCount:1}},{diagnostic:{...incident.diagnostic,code:'coverage_missing'}}]){
    const {state,options}=fixture();await rejects(repairSheet({...incident,...altered},options),'SHEET_INVALID_INCIDENT');assert.equal(state.launches,0);
  }
});
test('newer run supersedes without a write or launch',async()=>{
  const {state,options}=fixture({current:async()=>false});assert.equal((await repairSheet(incident,options)).status,'superseded');assert.equal(state.saves,0);assert.equal(state.launches,0);
});
test('concurrent recovery or healthy sheet is not resent',async()=>{
  const {state,options}=fixture({failureCurrent:async()=>false});assert.equal((await repairSheet(incident,options)).status,'superseded');assert.equal(state.launches,0);
});
test('latest context is checked again immediately before launching',async()=>{
  let calls=0;const {state,options}=fixture({current:async()=>++calls===1});assert.equal((await repairSheet(incident,options)).status,'superseded');assert.equal(state.launches,0);
});
test('existing matching execution is observed and never relaunched',async()=>{
  const {state,options}=fixture();state.stored={data:intent};state.executions=[execution()];assert.equal((await repairSheet(incident,options)).status,'completed');assert.equal(state.saves,0);assert.equal(state.launches,0);
});
test('launch intent without an observed execution fails uncertain without resending',async()=>{
  const {state,options}=fixture();state.stored={data:intent};await rejects(repairSheet(incident,options),'SHEET_LAUNCH_UNCERTAIN');assert.equal(state.launches,0);
});
test('lost launch response is recovered from execution without a second POST',async()=>{
  const {state,options}=fixture();options.launch=async()=>{state.launches++;state.executions=[execution()];throw Error('connection lost');};
  await rejects(repairSheet(incident,options),'SHEET_LAUNCH_UNCERTAIN');assert.equal((await repairSheet(incident,options)).status,'completed');assert.equal(state.launches,1);
});
test('CAS collision cannot launch a second publisher',async()=>{
  const {state,options}=fixture({save:async()=>{throw Object.assign(Error(),{status:412});}});await rejects(repairSheet(incident,options),'SHEET_LAUNCH_UNCERTAIN');assert.equal(state.launches,0);
});
test('explicit rejected launch is not misreported as publication success',async()=>{
  const {options}=fixture({launch:async()=>{throw Object.assign(Error(),{status:403});}});await rejects(repairSheet(incident,options),'SHEET_LAUNCH_REJECTED');
});
test('attempt identity mismatch and duplicate executions are rejected',async()=>{
  const {state,options}=fixture();const wrong=execution();wrong.template.containers[0].env.find(x=>x.name==='RUN_ID').value=importId;state.executions=[wrong];
  await rejects(repairSheet(incident,options),'SHEET_EXECUTION_IDENTITY');state.executions=[execution(),execution()];await rejects(repairSheet(incident,options),'SHEET_DUPLICATE_EXECUTION');assert.equal(state.launches,0);
});
test('failed execution cannot yield success from a publication log',async()=>{
  const {state,options}=fixture();state.executions=[execution({failedCount:1,succeededCount:0})];await rejects(repairSheet(incident,options),'SHEET_EXECUTION_FAILED');assert.equal(state.launches,0);
});
test('completed execution without run/hash evidence stops after log grace period',async()=>{
  const {state,options}=fixture({evidence:async()=>null});state.executions=[execution({completionTime:new Date(now-100000).toISOString()})];
  await rejects(repairSheet(incident,options),'SHEET_PUBLICATION_UNCONFIRMED');assert.equal(state.launches,0);
});
test('uncertain running execution is retained without launching again',async()=>{
  const {state,options}=fixture();state.executions=[execution({completionTime:null,succeededCount:0})];await rejects(repairSheet(incident,options),'SHEET_LAUNCH_UNCERTAIN');assert.equal(state.launches,0);
});
test('publication evidence binds project, job, execution, run, timestamp and full hash',()=>{
  const row={resource:{labels:{project_id:'spectre-tomstocks-20260227',job_name:'haraka-manman-akihabara-generate'}},labels:{'run.googleapis.com/execution_name':name.split('/').at(-1)},timestamp:new Date(now-2000).toISOString(),textPayload:`[buyback-sheet] published: store=manman-akihabara, run=${runId}, rows=1633, hash=${hash}`};
  assert.deepEqual(sheetPublicationEvidence([row],execution(),runId),{rowCount:1633,contentHash:hash});
  for(const wrong of [
    {...row,textPayload:row.textPayload.replace(runId,importId)},
    {...row,textPayload:row.textPayload.slice(0,-1)},
    {...row,timestamp:new Date(now-6000).toISOString()},
    {...row,labels:{'run.googleapis.com/execution_name':'other'}},
    {...row,resource:{labels:{project_id:'other',job_name:'haraka-manman-akihabara-generate'}}},
    {...row,resource:{labels:{project_id:'spectre-tomstocks-20260227',job_name:'haraka-oripark-generate'}}},
  ])assert.equal(sheetPublicationEvidence([wrong],execution(),runId),null);
});
test('real launch adapter targets only the existing Tokyo Sheet publisher with bounded overrides',async()=>{
  const {state,options}=fixture();delete options.launch;
  const originalFetch=globalThis.fetch;let launched;
  globalThis.fetch=async(url,init)=>{
    if(String(url)==='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token')return {ok:true,json:async()=>({access_token:'test-only',expires_in:3600})};
    assert.equal(String(url),'https://run.googleapis.com/v2/projects/spectre-tomstocks-20260227/locations/asia-northeast1/jobs/haraka-manman-akihabara-generate:run');
    assert.equal(init.method,'POST');launched=JSON.parse(init.body);state.executions=[execution()];return {ok:true};
  };
  try {
    assert.equal((await repairSheet(incident,options)).status,'completed');
    assert.equal(launched.overrides.taskCount,1);assert.equal(launched.overrides.timeout,'300s');
    assert.deepEqual(Object.fromEntries(launched.overrides.containerOverrides[0].env.map(x=>[x.name,x.value])),{
      JOB_NAME:'publish-buyback-sheet',STORE_NAME:'manman-akihabara',RUN_ID:runId,TOKYO_SHEET_REPAIR_ATTEMPT:attempt,TRIGGER:'tokyo-sheet-repair',
    });
  } finally {globalThis.fetch=originalFetch;}
});
