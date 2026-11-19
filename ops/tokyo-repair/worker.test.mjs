import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRuntimeBaseline } from './worker.mjs';

const manifests=['package.json','package-lock.json','tsconfig.base.json','packages/shared/package.json',
  'packages/shared/tsconfig.json','packages/job/package.json','packages/job/tsconfig.json'];
const contents='{\n  "name": "synthetic",\n  "value": 1\n}\n';
function fixture(t){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'haraka-worker-baseline-test-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const source=path.join(temp,'source'),runtime=path.join(temp,'runtime');
  for(const root of [source,runtime])for(const file of manifests){
    const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,root===runtime?contents.replace(/\n/g,'\r\n'):contents);
  }
  return {source,runtime};
}
test('Windows image CRLF and Linux checkout LF compare equally for all seven manifests',t=>{
  const {source,runtime}=fixture(t);
  assert.doesNotThrow(()=>assertRuntimeBaseline(source,runtime));
  assert.doesNotThrow(()=>assertRuntimeBaseline(runtime,source));
});
test('dependency/compiler changes and non-newline whitespace changes remain rejected in every file',t=>{
  const {source,runtime}=fixture(t);
  for(const file of manifests){
    const target=path.join(source,file);
    for(const value of [contents.replace('"value": 1','"value": 2'),contents.replace('  "name"',' "name"'),contents+'\n',contents.replace('\n','\r'), '\uFEFF'+contents]){
      fs.writeFileSync(target,value);
      assert.throws(()=>assertRuntimeBaseline(source,runtime),/baseline changed/);
    }
    fs.writeFileSync(target,contents);
  }
  assert.doesNotThrow(()=>assertRuntimeBaseline(source,runtime));
});
test('invalid UTF-8 is rejected instead of collapsing different bytes to replacement characters',t=>{
  const {source,runtime}=fixture(t);
  fs.writeFileSync(path.join(source,'package.json'),Buffer.from([0xff]));
  fs.writeFileSync(path.join(runtime,'package.json'),Buffer.from([0xfe]));
  assert.throws(()=>assertRuntimeBaseline(source,runtime),/not UTF-8/);
});
