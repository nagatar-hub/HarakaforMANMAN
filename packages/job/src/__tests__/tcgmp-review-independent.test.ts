import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { buildTcgmpReview } from '../scripts/build-tcgmp-review';
import { prepareTcgmpImageImport } from '../scripts/import-tcgmp-images';

test('offline candidate bytes -> escaped HTML -> validated decision export -> existing importer', async () => {
  const directory=await mkdtemp(join(tmpdir(),'tcgmp-review-independent-'));
  try {
    const bytes=await sharp({create:{width:200,height:280,channels:3,background:'#fff'}}).jpeg().toBuffer();
    const sha=createHash('sha256').update(bytes).digest('hex'),file=sha+'.jpg';
    await writeFile(join(directory,file),bytes);
    const target={id:'test-only-review',franchise:'ONE PIECE',name:'Luffy </script><script>BAD()</script> $&',model_number:'P-033'};
    const candidate={id:'423037',name:'Name </script> $&',sku:'OPP-033P',file,sha256:sha};
    const targetPath=join(directory,'targets.json'),reportPath=join(directory,'report.json'),output=join(directory,'review','index.html');
    await writeFile(targetPath,JSON.stringify([target,{...target,id:'not-collected',product_type:'box'}]));
    await writeFile(reportPath,JSON.stringify({target,collected_at:'2026-09-07T00:00:00Z',collection_complete:true,candidates:[candidate]}));
    const result=await buildTcgmpReview(targetPath,directory,output);
    expect(result.products).toBe(2);expect(result.candidates).toBe(1);
    const html=await readFile(output,'utf8');
    const embedded=html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)![1];
    expect(embedded).not.toContain('</script>');
    const data=JSON.parse(embedded);
    expect(data.items[0].name).toBe(target.name);
    expect(data.items[0].candidates[0].image).toMatch(/^data:image\/jpeg;base64,/);
    expect(data.items[1].collection).toBe('not_collected');
    expect(data.items.map((item: {product_type:string})=>item.product_type)).toEqual(['psa','box']);
    await writeFile(targetPath,JSON.stringify([{...target,product_type:'box'}]));
    expect((await buildTcgmpReview(targetPath,directory,output)).candidates).toBe(0);
    await writeFile(targetPath,JSON.stringify([target,{...target,id:'not-collected',product_type:'box'}]));
    expect(html).toContain('候補をまだ取得していません');
    expect(html).not.toMatch(/<img[^>]+src=["']https:\/\/(?:www\.tcgmp|d1sqsdq2kxn50g)/);
    const normalize=html.slice(html.indexOf('function normalizeDecisions('),html.indexOf('try{const saved='));
    const exported=html.slice(html.indexOf('function exported()'),html.indexOf("$('export').onclick="));
    const context=vm.createContext({items:data.items,data,decisions:{},labels:{adopt:'a',none:'n',hold:'h'}});
    vm.runInContext(normalize+exported,context);
    const decision={status:'adopt',candidateId:candidate.id,sha256:sha,no_sample:true,no_slab:true,variant_confirmed:true,note:'TEST ONLY offline export contract',at:'2026-09-07T00:00:00Z'};
    for(const change of [{no_sample:false},{no_slab:false},{variant_confirmed:false},{candidateId:'999'},{sha256:'0'.repeat(64)}]) {
      context.input={[target.id]:{...decision,...change}};
      expect(()=>vm.runInContext('normalizeDecisions(input)',context)).toThrow();
    }
    context.input={[target.id]:decision};
    vm.runInContext('decisions=normalizeDecisions(input)',context);
    const document=vm.runInContext('exported()',context);
    expect(document.kind).toBe('tcgmp_image_review_v1');expect(document.dataset_id).toBe(result.datasetId);
    const manifest=join(directory,'review','export.json');
    await writeFile(manifest,JSON.stringify(document));
    const prepared=await prepareTcgmpImageImport(manifest);
    expect(prepared[0].row.source_shinsoku_id).toBe(target.id);
    expect(prepared[0].row.sha256).toBe(sha);
    expect(prepared[0].bytes.equals(bytes)).toBe(true);
    expect(html).toContain('value.dataset_id!==data.datasetId');
    await writeFile(reportPath,JSON.stringify({target,candidates:[{...candidate,sku:'changed'}]}));
    expect((await buildTcgmpReview(targetPath,directory,output)).datasetId).not.toBe(result.datasetId);
    await writeFile(reportPath,JSON.stringify({target,candidates:[{...candidate,sha256:'0'.repeat(64)}]}));
    await expect(buildTcgmpReview(targetPath,directory,output)).rejects.toThrow();
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('real CLI main retains partial candidates on transport failure and reuses checked bytes on retry', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tcgmp-partial-independent-'));
  try {
    const bytes=await sharp({create:{width:200,height:280,channels:3,background:'#fff'}}).jpeg().toBuffer();
    const sha=createHash('sha256').update(bytes).digest('hex'),file=sha+'.jpg';
    const target={id:'offline-test',franchise:'ONE PIECE',name:'Luffy',model_number:'P-033'};
    const fingerprint=createHash('sha256').update(JSON.stringify(target)).digest('hex');
    const report=join(directory,`${target.id}-${fingerprint.slice(0,12)}.json`);
    await writeFile(join(directory,'targets.json'),JSON.stringify([target]));
    await writeFile(join(directory,file),bytes);
    await writeFile(report,JSON.stringify({fingerprint,target,collection_complete:false,candidates:[{id:'423037',file,sha256:sha}]}));
    const source=await readFile(resolve(__dirname,'../scripts/scrape-tcgmp.ts'),'utf8');
    const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const getDetail=jest.fn(()=>{throw Error('Unexpected detail request');}),getImage=jest.fn(()=>{throw Error('Unexpected image request');});
    let searchCalls=0;
    async function run(fail:boolean|string) {
      searchCalls=0;
      const mockProcess={argv:['node','cli',join(directory,'targets.json'),directory],pid:1,exitCode:0};
      const fakeRequire:any=(id:string)=>id==='../lib/tcgmp.js'?{TCGMP_CATEGORY:{'ONE PIECE':57},searchTcgmp:async()=>{searchCalls++;if(fail&&searchCalls===1)throw Error(typeof fail==='string'?fail:'offline transport failure');return typeof fail==='string'?[]:[{id:'423037'}];},getTcgmpDetail:getDetail,getTcgmpImage:getImage}:require(id);
      const context=vm.createContext({require:fakeRequire,module:{},exports:{},__dirname:join(directory,'a/b/c/d'),process:mockProcess,console:{log:()=>{},error:()=>{}},Buffer,Error});
      vm.runInContext(js+'\nglobalThis.finished=main();',context);
      await context.finished;
      return mockProcess.exitCode;
    }
    expect(await run(true)).toBe(1);
    let saved=JSON.parse(await readFile(report,'utf8'));
    expect(saved.candidates).toHaveLength(1);expect(saved.error).toBe('offline transport failure');
    expect(await run(false)).toBe(0);
    saved=JSON.parse(await readFile(report,'utf8'));
    expect(saved.collection_complete).toBe(true);expect(saved.candidates).toHaveLength(1);
    expect(getDetail).not.toHaveBeenCalled();expect(getImage).not.toHaveBeenCalled();
    await writeFile(join(directory,'targets.json'),JSON.stringify([target,{...target,id:'second'}]));
    await writeFile(report,JSON.stringify({...saved,collection_complete:false}));
    expect(await run('TCGMP transport error (ECONNRESET)')).toBe(1);
    expect(searchCalls).toBe(2);
    await writeFile(report,JSON.stringify({...saved,collection_complete:false}));
    expect(await run('TCGMP HTTP 429')).toBe(1);
    expect(searchCalls).toBe(1);
  } finally {await rm(directory,{recursive:true,force:true});}
});
