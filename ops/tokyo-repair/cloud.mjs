import { deflateRawSync } from 'node:zlib';
const project='spectre-tomstocks-20260227';
export const region='asia-northeast1';
export const location='projects/'+project+'/locations/'+region;
export const imageRepo=region+'-docker.pkg.dev/'+project+'/haraka/haraka-manman-job';
export const github='https://github.com/nagatar-hub/HarakaforMANMAN.git';
export const expectedRepo=location+'/connections/haraka-tokyo-repair-github/repositories/harakafor-manman';
export const stateBucket=project+'-haraka-tokyo-repair-state';
export const dataBucket=project+'-haraka-tokyo-repair-artifacts';
export const secret='projects/'+project+'/secrets/haraka-tokyo-repair-openai-api-key/versions/latest';
export const serviceAccount=kind=>'projects/'+project+'/serviceAccounts/haraka-tokyo-repair-'+kind+'@'+project+'.iam.gserviceaccount.com';
export const jobName=stage=>{if(!['sync','generate'].includes(stage))throw Error('Unexpected stage');return location+'/jobs/haraka-manman-akihabara-'+stage};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let cached;
export async function accessToken(){
  if(cached&&cached.until>Date.now()+60000)return cached.token;
  const response=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Metadata authentication failed');
  const data=await response.json();cached={token:data.access_token,until:Date.now()+1000*data.expires_in};return cached.token;
}
export async function google(url,init={}){
  const result=await fetch(url,{...init,headers:{authorization:'Bearer '+await accessToken(),...init.headers},redirect:'error',signal:AbortSignal.timeout(35000)});
  if(!result.ok){const e=Error('Google API '+result.status+' '+new URL(url).pathname);e.status=result.status;throw e}
  return result;
}
export function json(method,value){return {method,headers:{'content-type':'application/json'},body:JSON.stringify(value)}}
export async function readObject(bucket,key){
  const url='https://storage.googleapis.com/storage/v1/b/'+bucket+'/o/'+encodeURIComponent(key);
  try{const meta=await (await google(url+'?fields=generation,size')).json();
    if(Number(meta.size)>40000000)throw Error('Object size limit');
    return {generation:meta.generation,data:await(await google(url+'?alt=media&generation='+meta.generation)).json()};
  }catch(e){if(e.status===404)return null;throw e}
}
export async function writeObject(bucket,key,data,generation='0'){
  const url='https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o?uploadType=media&name='+encodeURIComponent(key)+'&ifGenerationMatch='+generation;
  return (await(await google(url,json('POST',data))).json()).generation;
}
export async function build(spec,phase){
  const self=process.env.REPAIR_SELF_IMAGE;
  if(!new RegExp('^'+region+'-docker\\.pkg\\.dev/'+project+'/haraka/haraka-tokyo-repair@sha256:[a-f0-9]{64}$').test(self??''))throw Error('Controller image must be pinned');
  const proposal=phase==='propose';
  if(!proposal&&phase!=='verify')throw Error('Unknown build phase');
  const inputKey='proposals/'+spec.attempt+'.json',base=spec.base;
  const tag='repair-'+spec.attempt;
  const opts={machineType:'E2_HIGHCPU_8',logging:'CLOUD_LOGGING_ONLY'};
  const common={options:opts,timeout:proposal?'600s':'1200s',tags:['tokyo-repair',tag,phase],serviceAccount:serviceAccount(proposal?'build':'release')};
  const step=(cmd,args,extra={})=>({name:self,entrypoint:cmd,args,...extra});
  let body;
  if(proposal){
    body={...common,availableSecrets:{secretManager:[{versionName:secret,env:'CODEX_API_KEY'}]},
      steps:[step('node',['/opt/runtime/ops/tokyo-repair/worker.mjs','propose',base,spec.stage,spec.attempt,deflateRawSync(JSON.stringify(spec.diagnostic)).toString('base64url')],{secretEnv:['CODEX_API_KEY']})]};
  }else{
    const builtImage=imageRepo+':'+tag;
    body={...common,steps:[
      {name:'gcr.io/cloud-builders/docker',args:['run','--rm','--network=none','--cap-drop=ALL','--cap-add=CHOWN','--security-opt=no-new-privileges','--user=0:0','-v','/workspace:/work','--entrypoint','chown',self,'1000:1000','/work']},
      step('node',['/opt/runtime/ops/tokyo-repair/worker.mjs','prepare',base,spec.stage,spec.attempt,inputKey,spec.fixtureKey]),
      {name:'gcr.io/cloud-builders/docker',args:['run','--rm','--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--read-only','--tmpfs','/tmp:rw,nosuid,size=2048m','-v','/workspace:/work:ro','--entrypoint','node',self,'/opt/runtime/ops/tokyo-repair/worker.mjs','test']},
      {name:'gcr.io/cloud-builders/docker',args:['build','-t',builtImage,'-f','/workspace/candidate/packages/job/Dockerfile','/workspace/candidate']},
    ],images:[builtImage]};
  }
  const baseUrl='https://cloudbuild.googleapis.com/v1/'+location+'/builds';
  const op=await(await google(baseUrl,json('POST',body))).json();
  const id=op.metadata?.build?.id;if(!id)throw Error('Build launch outcome unknown');console.log(phase+' build '+id);
  for(let i=0;i<155;i++){
    const b=await(await google(baseUrl+'/'+id)).json();
    if(b.status==='SUCCESS')return {id,digest:b.results?.images?.[0]?.digest};
    if(!['QUEUED','WORKING','PENDING'].includes(b.status))throw Error(phase+' build '+id+' '+b.status);
    await delay(9000);
  }
  throw Error('Build completion timed out '+id);
}
export async function job(stage){return (await google('https://run.googleapis.com/v2/'+jobName(stage))).json()}
export async function changeImage(stage,previous,next,oldRevision,newRevision){
  const current=await job(stage), container=current.template?.template?.containers?.[0], env=container?.env;
  if(current.name!==jobName(stage)||!current.etag||container?.image!==previous||!Array.isArray(env)
    ||env.filter(x=>x.name==='TOKYO_REPAIR_SOURCE_REVISION').length!==1
    ||env.find(x=>x.name==='TOKYO_REPAIR_SOURCE_REVISION')?.value!==oldRevision)throw Error('Runtime image or source changed');
  if(!/^[a-f0-9]{40}$/.test(oldRevision)||!/^[a-f0-9]{40}$/.test(newRevision)
    ||next!==imageRepo+'@sha256:'+next.split('@sha256:')[1]||!/^.+@sha256:[0-9a-f]{64}$/.test(next))throw Error('Unexpected target image or revision');
  // Preserve every container field, including secret references. The etag fences concurrent operator updates.
  container.image=next;env.find(x=>x.name==='TOKYO_REPAIR_SOURCE_REVISION').value=newRevision;
  const url='https://run.googleapis.com/v2/'+jobName(stage);
  const update=Object.fromEntries(['name','etag','labels','annotations','client','clientVersion','launchStage','binaryAuthorization','template']
    .filter(key=>current[key]!==undefined).map(key=>[key,current[key]]));
  const op=await(await google(url,json('PATCH',update))).json();
  if(typeof op.name!=='string'||!op.name.startsWith(location+'/operations/'))throw Error('Job update outcome unknown');
  for(let i=0;i<45;i++){
    const status=await(await google('https://run.googleapis.com/v2/'+op.name)).json();
    if(status.done){if(status.error)throw Error('Job update failed');const check=(await job(stage)).template.template.containers[0];
      if(check.image!==next||check.env?.find(x=>x.name==='TOKYO_REPAIR_SOURCE_REVISION')?.value!==newRevision)throw Error('Job update readback failed');return}
    await delay(2000);
  }
  throw Error('Job update outcome unknown');
}
