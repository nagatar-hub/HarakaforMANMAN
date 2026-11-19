import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const lib = 'packages/job/src/lib/';
export const lanes = {
  sync: {
    [lib+'tokyo-normal-cards.ts']: ['resolveTokyoProductTag','buildTokyoPreparedCards'],
    [lib+'oripark-coverage.ts']: ['keys','coverageMatches','separatedEditions','completeOriparkCoverage'],
    [lib+'haraka-card-images.ts']: ['findHarakaImage']
  },
  generate: {
    [lib+'page-planner.ts']: ['matchesRule','assignGroupToLayouts','assignBoxGroup','planPages','sortByPriceDesc','sortByNestedTagThenPrice'],
    'packages/job/src/jobs/generate.ts': ['planTokyoGalleryPages','makeFixedBoxPlans']
  }
};
const reject = message => {throw new Error('Repair policy: '+message)};
const tree = (name,text) => ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);
const visit = (node,fn) => {fn(node);ts.forEachChild(node, child => {visit(child,fn)});};
const identifiers = node => {const out=new Set();visit(node,n=>{if(ts.isIdentifier(n))out.add(n.text)});return out};
const forbidden = /\b(?:process|globalThis|global|require|import|export|constructor|prototype|__proto__|__defineGetter__|__defineSetter__|eval|Function|Reflect|Proxy|fetch|WebAssembly|Buffer|Deno|Bun|setTimeout|console|child_process|https?|fs|module|exports|this|Atomics|Symbol|setImmediate)\b/;
const safeCalls = new Set('get set has add map flatMap filter find findIndex some every sort slice join includes startsWith endsWith trim toLowerCase toUpperCase replace replaceAll normalize push values entries keys from isArray isSafeInteger min max floor round test split indexOf reduce'.split(' '));
function authorizeChange(file, original, changed, allowed) {
  const a=tree(file,original), b=tree(file,changed);
  if(b.parseDiagnostics.length || a.statements.length!==b.statements.length) reject('module structure changed');
  let changedFns=0;
  for(let i=0;i<a.statements.length;i++){
    const left=a.statements[i],right=b.statements[i];
    if(left.getFullText()===right.getFullText())continue;
    if(!ts.isFunctionDeclaration(left)||!ts.isFunctionDeclaration(right)||!allowed.includes(left.name?.text)
      ||left.name.text!==right.name?.text||!left.body||!right.body
      ||original.slice(left.pos,left.body.pos)!==changed.slice(right.pos,right.body.pos))reject('only listed pure function bodies may change');
    const oldCalls=new Set(), localFns=new Set(), oldIndex=new Set();
    const guards=body=>{
      const items=[];
      visit(body,n=>{
        if(!ts.isThrowStatement(n))return;
        const conditions=[];
        for(let parent=n.parent;parent&&parent!==body;parent=parent.parent){
          if(ts.isIfStatement(parent))conditions.push(parent.expression.getText());
        }
        items.push(JSON.stringify([n.getText(),conditions]));
      });
      return items;
    };
    visit(left.body,n=>{
      if(ts.isCallExpression(n))oldCalls.add(n.expression.getText());
      if(ts.isElementAccessExpression(n))oldIndex.add(n.getText());
    });
    const retained=new Set(guards(right.body));
    if(guards(left.body).some(t=>!retained.has(t)))reject('existing error guards must be preserved');
    const allowedNames=identifiers(left.body);
    visit(right.body,n=>{if(ts.isVariableDeclaration(n)&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer)))localFns.add(n.name.getText())});
    visit(right.body,n=>{
      if(ts.isCallExpression(n)){
        const call=n.expression;
        if(oldCalls.has(call.getText())||ts.isIdentifier(call)&&localFns.has(call.text))return;
        if(ts.isPropertyAccessExpression(call)&&safeCalls.has(call.name.text))return;
        reject('unapproved call '+call.getText().slice(0,60));
      }
      if(ts.isNewExpression(n)&&!(ts.isIdentifier(n.expression)&&['Map','Set','Error','URL','Date'].includes(n.expression.text)))reject('unapproved constructor');
      if(ts.isElementAccessExpression(n)&&!oldIndex.has(n.getText())&&!ts.isNumericLiteral(n.argumentExpression))reject('unsupported computed access');
      if(ts.isComputedPropertyName(n)||ts.isGetAccessor(n)||ts.isSetAccessor(n)||ts.isClassExpression(n)
        ||ts.isTaggedTemplateExpression(n)||ts.isWithStatement(n)||ts.isAwaitExpression(n)||ts.isDeleteExpression(n))reject('unsupported operation');
      if(ts.isIdentifier(n)&&!allowedNames.has(n.text)&&forbidden.test(n.text))reject('unsupported identifier');
    });
    changedFns++;
  }
  if(!changedFns)reject('empty edit');
}
export function applyProposal(root,stage,proposal){
  if(!Object.hasOwn(lanes,stage)||proposal?.decision!=='repair'||!Array.isArray(proposal.edits)
    ||proposal.edits.length<1||proposal.edits.length>5)reject('no bounded repair');
  const files=new Map();let changedLines=0;
  for(const edit of proposal.edits){
    if(!Object.hasOwn(lanes[stage],edit.path)||typeof edit.before!=='string'||!edit.before||typeof edit.after!=='string')reject('invalid path or edit');
    if(edit.before.length+edit.after.length>20000||edit.before===edit.after||forbidden.test(edit.after)||/[@]ts-|[\u0000\r]|\\(?:u|x)[{0-9a-f]|(?:https?:\/\/)/i.test(edit.after))reject('edit exceeds allowed operations');
    const loc=path.join(root,edit.path);
    if(fs.realpathSync(loc)!==loc)reject('symlink');
    const file=files.get(loc)??{path:edit.path,original:fs.readFileSync(loc,'utf8')};
    const current=file.changed??file.original;
    if(current.split(edit.before).length!==2)reject('anchor missing or ambiguous');
    file.changed=current.replace(edit.before,()=>edit.after);files.set(loc,file);
    changedLines+=edit.before.split('\n').length+edit.after.split('\n').length;
  }
  if(files.size>2||changedLines>120)reject('patch too large');
  for(const file of files.values())authorizeChange(file.path,file.original,file.changed,lanes[stage][file.path]);
  for(const [loc,file] of files)fs.writeFileSync(loc,file.changed);
  return [...files.values()].map(f=>f.path);
}
