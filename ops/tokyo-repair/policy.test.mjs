import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProposal } from './policy.mjs';

const file = 'packages/job/src/lib/tokyo-normal-cards.ts';
const source = "export function resolveTokyoProductTag(tags: string[]) {\n  if (!tags.length) throw new Error('Missing tags');\n  return tags[0];\n}\n";
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'haraka-policy-')), target = path.join(dir,file);
  fs.mkdirSync(path.dirname(target),{ recursive:true });fs.writeFileSync(target,source);
  const apply = (before,after,p=file) => applyProposal(dir,'sync',{decision:'repair',edits:[{path:p,before,after}]});
  try { fn(apply,target); } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
test('an exact and unique local normalization stays inside the chosen function',() => fixture((apply,target)=>{
  assert.deepEqual(apply('return tags[0];','return tags[0].trim();'),[file]);
  assert.match(fs.readFileSync(target,'utf8'),/\.trim\(\)/);
}));
test('off-lane, over-sized, dynamic and external edits leave the working file unchanged',()=>fixture((apply,target)=>{
  for(const [before,after,where] of [
    ['return tags[0];','return tags[1];','packages/job/src/jobs/sync.ts'],
    ['missing','return tags[1];'],['return tags[0];','return tags[key];'],
    ['return tags[0];','return process.env.TOKEN;'],
    ['return tags[0];','return tags[0].send();'],
    ['return tags[0];','\n'.repeat(121)+'return tags[0];'],
    ['if (!tags.length)','if (false)'],
    ["throw new Error('Missing tags');","{ /* throw new Error('Missing tags'); */ }"],
    ['resolveTokyoProductTag(tags:','resolveTokyoProductTag(value:'],
  ]) assert.throws(()=>apply(before,after,where));
  assert.equal(fs.readFileSync(target,'utf8'),source);
}));
