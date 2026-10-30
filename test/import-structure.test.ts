import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { planSkos, importRequestSchema, exportSkos } from '../src/skos.js';
import { planGraph } from '../src/graph-import.js';
import { createApp } from '../src/server.js';
const header='@prefix s:<http://www.w3.org/2004/02/skos/core#>. @prefix x:<urn:example:>. @prefix app:<urn:terminology-mcp:vocab:>. x:scheme a s:ConceptScheme; s:prefLabel "Scheme". ';
const nodes='x:a s:inScheme x:scheme; s:prefLabel "A". x:b s:inScheme x:scheme; s:prefLabel "B". x:c s:inScheme x:scheme; s:prefLabel "C". ';
const req=(hierarchy: 'auto'|'tree'|'poly'|'graph'='auto')=>importRequestSchema.parse({format:'turtle',sourceScheme:'urn:example:scheme',schemeId:'imported',hierarchy});
function fixture(t:test.TestContext){const store=new Store(':memory:');t.after(()=>store.close());return store;}

test('Auto recommends tree, polyhierarchy, associative graph or ambiguous flat graph without altering edges',t=>{
 const store=fixture(t);
 for(const [edges,recommended] of [
  ['x:b s:broader x:a. x:c s:broader x:a.','tree'],
  ['x:c s:broader x:a,x:b.','poly'],
  ['x:b s:broader x:a. x:c s:related x:b.','graph'],
  ['','graph'],
 ] as const){
  const {plan,analysis}=planSkos(store,header+nodes+edges,req());
  assert.equal(analysis.recommended,recommended);assert.equal(plan.scheme.hierarchy,recommended);assert.equal(analysis.compatible,true);
  assert.equal(plan.terms.reduce((n,t)=>n+t.broader.length,0),analysis.stats.broaderLinks);
 }
 assert.equal(planSkos(store,header+nodes,req()).analysis.stats.isolated,3);
});

test('valid declarations are honored; incompatible or ambiguous declarations are explained and replaced by a recommendation',t=>{
 const store=fixture(t),associative=header+nodes+'x:b s:broader x:a. x:c s:related x:b. ';
 const declared=planSkos(store,associative+'x:scheme app:hierarchy "tree".',req());
 assert.equal(declared.analysis.selected,'tree');assert.equal(declared.analysis.stats.associativeLinks,1);
 const incompatible=planSkos(store,header+nodes+'x:c s:broader x:a,x:b. x:scheme app:hierarchy "tree".',req());
 assert.equal(incompatible.analysis.selected,'poly');assert.match(incompatible.analysis.reason,/incompatible/);
 assert.ok(incompatible.analysis.compatibility.tree.reasons.some(reason=>reason.includes('C')));
 const ambiguous=planSkos(store,associative+'x:scheme app:hierarchy "tree","poly".',req());
 assert.equal(ambiguous.analysis.selected,'graph');assert.match(ambiguous.analysis.reason,/ambiguous declaration/);
});

test('manual overrides preserve all relationships and incompatible overrides expose a matrix without flattening parents',t=>{
 const store=fixture(t),data=header+nodes+'x:c s:broader x:a,x:b; s:related x:a.';
 const {plan,analysis}=planSkos(store,data,req('tree'));
 assert.equal(analysis.compatible,false);assert.equal(analysis.recommended,'graph');
 assert.equal(analysis.compatibility.poly.compatible,true);assert.equal(analysis.compatibility.graph.compatible,true);
 assert.equal(plan.terms.find(t=>t.label==='C')?.broader.length,2);
 assert.throws(()=>store.importScheme(plan,0),/one broader/);assert.equal(store.version,0);
 const poly=planSkos(store,data,req('poly'));store.importScheme(poly.plan,0);
 assert.equal(store.lookup('urn:example:c').broader.length,2);assert.equal(store.lookup('urn:example:c').relations.length,1);
});

test('broader cycles block every mode, while associative cycles remain compatible',t=>{
 const store=fixture(t);
 const cyclic=planSkos(store,header+nodes+'x:a s:broader x:b. x:b s:broader x:a.',req());
 for(const type of ['tree','poly','graph'] as const){assert.equal(cyclic.analysis.compatibility[type].compatible,false);assert.match(cyclic.analysis.compatibility[type].reasons.join(),/cycle/);}
 const related=planSkos(store,header+nodes+'x:a s:related x:b. x:b s:related x:c. x:c s:related x:a.',req());
 for(const type of ['tree','poly','graph'] as const)assert.equal(related.analysis.compatibility[type].compatible,true);
});

test('path-label collisions require graph and native JSON preserves valid source declarations',async t=>{
 const store=fixture(t),collision=header+'x:a s:inScheme x:scheme; s:prefLabel "Same!". x:b s:inScheme x:scheme; s:prefLabel "Same".';
 const analysed=planSkos(store,collision,req());assert.equal(analysed.analysis.selected,'graph');assert.equal(analysed.analysis.compatibility.poly.compatible,false);
 const data=JSON.stringify({format:'terminology-graph/1',schemes:[{id:'source',label:'Source',hierarchy:'poly'}],concepts:[{id:'a',scheme:'source',label:'A'}],relations:[]});
 const input=importRequestSchema.parse({format:'graph-json',sourceScheme:'urn:terminology-mcp:scheme:source',schemeId:'copy'});
 assert.equal(planGraph(store,data,input).analysis.selected,'poly');
 store.importScheme(planSkos(store,header+nodes+'x:b s:broader x:a.',req('tree')).plan,0);
 const ttl=await exportSkos(store,'imported');assert.equal(planSkos(store,ttl,{...req(),schemeId:'copy'}).analysis.selected,'tree');
});

test('HTTP preview reports incompatible structures read-only, and apply still enforces the constraints',async t=>{
 const store=fixture(t),server=createApp(store);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const post=(path:string,data:unknown)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const response=await post('imports/preview',{...req('tree'),data:header+nodes+'x:c s:broader x:a,x:b.'});
 assert.equal(response.status,200);const preview=await response.json();assert.equal(preview.analysis.compatible,false);assert.equal(store.version,0);
 assert.equal((await post('imports/apply',{plan:preview.plan,expectedVersion:0})).status,422);assert.equal(store.schemes().length,0);
});
