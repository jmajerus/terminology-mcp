import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { conceptGraph } from '../src/graph.js';
import { graphSchemes, planGraph } from '../src/graph-import.js';
import { importRequestSchema, exportSkos, planSkos } from '../src/skos.js';
import { createApp } from '../src/server.js';

const sample = JSON.stringify({ format:'quote-mcp-export/1', schemes:[{id:1,slug:'human-work',label:'Human work',description:'Concept network'}], concepts:[
 {id:1,scheme:'human-work',slug:'psychic-prison',label:'psychic prison',alt_labels:['psychological prison'],definition:'A network example.',status:'confirmed',source:'drupal:kid:44',close_match:'NA'},
 {id:2,scheme:'human-work',slug:'organizational-psychodynamics',label:'organizational psychodynamics',status:'confirmed'},
 {id:3,scheme:'human-work',slug:'false-self',label:'false self',status:'confirmed'},
 {id:4,scheme:'human-work',slug:'unconscious',label:'unconscious',status:'confirmed'},
 {id:5,scheme:'human-work',slug:'true-self',label:'true self',status:'confirmed',close_match:'https://example.org/wordnet/true-self'},
 {id:6,scheme:'human-work',slug:'isolated',label:'Disconnected concept',status:'confirmed'},
 ],relations:[
 {from:'psychic-prison',to:'organizational-psychodynamics',type:'broader'},
 {from:'organizational-psychodynamics',to:'psychic-prison',type:'narrower'},
 {from:'psychic-prison',to:'false-self',type:'related'},
 {from:'false-self',to:'psychic-prison',type:'related'},
 {from:'false-self',to:'unconscious',type:'related'},
 {from:'unconscious',to:'psychic-prison',type:'related'},
 {from:'false-self',to:'true-self',type:'inverse'},
 ],works:[{title:'Must not become vocabulary'}],quotes:[{text:'Must not become vocabulary'}] });
const request = () => importRequestSchema.parse({format:'graph-json',sourceScheme:'urn:quote-mcp:scheme:human-work',schemeId:'human-work',hierarchy:'graph'});
function fixture(t: test.TestContext) {
 const store=new Store(':memory:');t.after(()=>store.close());
 store.importScheme(planGraph(store,sample,request()).plan,0);
 const concept=(slug:string)=>store.lookup(`quote-mcp:human-work:${slug}`);
 return {store,concept};
}

test('quote graph import preserves concepts, definitions, aliases, provenance, WordNet links and cyclic associations',t=>{
 const {store,concept}=fixture(t);
 assert.equal(graphSchemes(sample)[0].uri,request().sourceScheme);
 assert.equal(store.terms().length,6);assert.equal(store.schemes()[0].hierarchy,'graph');
 const prison=concept('psychic-prison');assert.equal(prison.scopeNote,'A network example.');assert.deepEqual(prison.altLabels,['psychological prison']);
 assert.ok(prison.aliases.includes('drupal:kid:44'));assert.equal(prison.path,null);
 assert.deepEqual(concept('true-self').links,[{uri:'https://example.org/wordnet/true-self',match:'closeMatch'}]);
 assert.ok(conceptGraph(store).relations.some(e=>e.type==='opposite'));
 const graph=conceptGraph(store,{around:prison.id,depth:1});assert.equal(graph.concepts.length,4);
 assert.equal(graph.relations.filter(e=>e.from===prison.id).length,3);
 assert.ok(conceptGraph(store).concepts.some(c=>c.id===concept('isolated').id));
});

test('graph schemes allow homonymous concepts while tree path uniqueness and broader-cycle validation remain',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 store.addScheme({id:'graph',label:'Graph',hierarchy:'graph'});
 const a=store.addTerm({scheme:'graph',label:'Same'}),b=store.addTerm({scheme:'graph',label:'Same'});
 store.setRelation(a.id,b.id,'related',true,store.version);
 assert.equal(conceptGraph(store).relations.length,2);
 store.operate(a.id,{kind:'move',broader:[b.id],expectedVersion:store.version});
 assert.throws(()=>store.operate(b.id,{kind:'move',broader:[a.id],expectedVersion:store.version}),/cycle/);
 store.addScheme({id:'tree',label:'Tree',hierarchy:'tree'});store.addTerm({scheme:'tree',label:'Same'});
 assert.throws(()=>store.addTerm({scheme:'tree',label:'Same'}),/sibling/);
});

test('graph reads follow directional and symmetric types, versions, aliases and set-induced edges',t=>{
 const {store,concept}=fixture(t),prison=concept('psychic-prison'),self=concept('false-self');
 const version=store.version;
 assert.deepEqual(conceptGraph(store,{around:prison.id,types:['broader']}).concepts.map(c=>c.id).sort(),[prison.id,concept('organizational-psychodynamics').id].sort());
 assert.ok(conceptGraph(store,{around:self.id,depth:1,types:['related']}).concepts.some(c=>c.id===prison.id));
 assert.throws(()=>conceptGraph(store,{depth:6}));assert.throws(()=>conceptGraph(store,{around:prison.id,scheme:'missing'}),/not found/);
 const set=store.saveSet({scheme:'human-work',slug:'network',label:'Network',members:[prison.id,self.id]},store.version);
 const result=conceptGraph(store,{set:set.id});assert.equal(result.concepts.length,2);assert.equal(result.relations.length,2);
 store.setRelation(prison.id,self.id,'related',false,store.version);
 assert.equal(conceptGraph(store,{set:set.id}).relations.length,0);
 assert.ok(conceptGraph(store,{at:version}).relations.some(e=>e.from===prison.id&&e.to===self.id));
});

test('relationship edits are atomic, symmetric, stale-safe, and removable through either editor',t=>{
 const {store,concept}=fixture(t),a=concept('psychic-prison'),b=concept('true-self');
 const version=store.version;store.setRelation(a.id,b.id,'related',true,version);
 assert.ok(store.lookup(a.id).relations.some(e=>e.target===b.id));assert.ok(store.lookup(b.id).relations.some(e=>e.target===a.id));
 assert.throws(()=>store.setRelation(a.id,b.id,'related',false,version),/workspace changed/);
 const saved=store.lookup(b.id);
 store.editTerm(b.id,{label:saved.label,altLabels:saved.altLabels,scopeNote:saved.scopeNote,status:'active',links:saved.links,notations:saved.notations,
  relations:saved.relations.filter(e=>e.target!==a.id),expectedChanged:saved.changed});
 assert.ok(!store.lookup(a.id).relations.some(e=>e.target===b.id&&e.type==='related'));
 assert.throws(()=>store.setRelation(a.id,a.id,'related',true,store.version),/itself/);
 store.addScheme({id:'other',label:'Other',hierarchy:'graph'});const other=store.addTerm({scheme:'other',label:'Other'});
 const before=store.version;assert.throws(()=>store.setRelation(a.id,other.id,'opposite',true,before),/cross schemes/);assert.equal(store.version,before);
});

test('graph import rejects missing/ambiguous endpoints and invalid hierarchies without partial writes',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 for(const alter of [(d:any)=>d.relations.push({from:'psychic-prison',to:'missing',type:'related'}),
  (d:any)=>d.concepts.push({...d.concepts[0],id:99}),
  (d:any)=>d.relations.push({from:'organizational-psychodynamics',to:'psychic-prison',type:'broader'})]) {
  const data=JSON.parse(sample);alter(data);
  assert.throws(()=>store.importScheme(planGraph(store,JSON.stringify(data),request()).plan,0));assert.equal(store.version,0);
 }
});

test('graph JSON and SKOS preserve the complete network across export/reimport',async t=>{
 const {store}=fixture(t),exported=conceptGraph(store,{scheme:'human-work'});
 for(const format of ['graph-json','turtle'] as const) {
  const copy=new Store(':memory:');t.after(()=>copy.close());
  const input=importRequestSchema.parse({...request(),format,schemeId:'copy'});
  const data=format==='graph-json'?JSON.stringify(exported):await exportSkos(store,'human-work');
  const plan=(format==='graph-json'?planGraph(copy,data,input):planSkos(copy,data,input)).plan;
  copy.importScheme(plan,0);
  const fingerprint=(s:Store)=>{const g=conceptGraph(s),byId=new Map(g.concepts.map(c=>[c.id,c.sourceUri]));return g.relations.map(e=>`${byId.get(e.from)}:${e.type}:${byId.get(e.to)}`).sort();};
  assert.deepEqual(fingerprint(copy),fingerprint(store));
 }
});

test('recipes can walk broader/narrower neighbourhoods as clients expect',t=>{
 const {store,concept}=fixture(t),root=concept('organizational-psychodynamics');
 const set=store.saveSet({scheme:'human-work',slug:'descendants',label:'Descendants',recipe:{around:[{term:root.id,depth:1,types:['narrower']}]}},store.version);
 assert.deepEqual(new Set(store.expandSet(set.id).terms.map(t=>t.id)),new Set([root.id,concept('psychic-prison').id]));
});

test('HTTP exposes graph-shaped set reads and full connections including incoming links',async t=>{
 const {store,concept}=fixture(t),prison=concept('psychic-prison');
 const server=createApp(store);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const graph=await(await fetch(base+'/api/graph?scheme=human-work&around='+prison.id)).json();assert.equal(graph.concepts.length,4);
 const term=await(await fetch(base+'/api/terms/'+prison.id)).json();assert.ok(term.connections.some((e:any)=>e.type==='broader'));
 const set=store.saveSet({scheme:'human-work',slug:'api',label:'API',members:[prison.id,concept('false-self').id]},store.version);
 const setGraph=await(await fetch(`${base}/api/sets/${set.id}/graph`)).json();assert.equal(setGraph.relations.length,2);
 for(const path of ['/graph','/graph.js'])assert.equal((await fetch(base+path)).status,200);
 // The page's force layout loads d3-force and its dependencies from this origin.
 const page=await(await fetch(base+'/graph')).text();
 for(const name of ['d3-dispatch','d3-quadtree','d3-timer','d3-force']){
  assert.ok(page.includes(`/vendor/${name}.js`));
  const script=await fetch(`${base}/vendor/${name}.js`);assert.equal(script.status,200);assert.match(script.headers.get('content-type')??'',/javascript/);
 }
 assert.match(await(await fetch(base+'/vendor/d3-force.js')).text(),/forceSimulation/);
 assert.equal((await fetch(base+'/api/graph?types=unknown')).status,422);
});

test('graph JSON keeps scheme notations through export and import',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const notations=[{value:'HW',datatype:'http://www.w3.org/2001/XMLSchema#string'}];
 store.addScheme({id:'coded',label:'Coded',hierarchy:'graph',notations,sourceUri:'https://example.org/coded'});store.addTerm({scheme:'coded',label:'One'});
 const copy=new Store(':memory:');t.after(()=>copy.close());
 copy.importScheme(planGraph(copy,JSON.stringify(conceptGraph(store,{scheme:'coded'})),importRequestSchema.parse({format:'graph-json',sourceScheme:'https://example.org/coded',schemeId:'coded',hierarchy:'graph'})).plan,0);
 assert.deepEqual(copy.schemes().find(s=>s.id==='coded')!.notations,notations);
});
