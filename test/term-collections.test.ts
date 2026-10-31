import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import type { TermView } from '../src/model.js';
function fixture(t:test.TestContext){
 const store=new Store(':memory:');t.after(()=>store.close());store.addScheme({id:'subjects',label:'Subjects',hierarchy:'tree'});
 const a=store.addTerm({scheme:'subjects',label:'A',status:'active'}),b=store.addTerm({scheme:'subjects',label:'B',status:'active'});
 const ordered=store.saveSet({scheme:'subjects',slug:'ordered',label:'Ordered',ordered:true,members:[b.id]},store.version);
 const plain=store.saveSet({scheme:'subjects',slug:'plain',label:'Plain'},store.version);
 return {store,a,b,ordered,plain};
}
function fields(t:TermView){return {label:t.label,scopeNote:t.scopeNote,altLabels:t.altLabels,status:t.status==='retired'?'active':t.status,notations:t.notations,relations:t.relations,links:t.links,expectedChanged:t.changed};}

test('term fields and multiple direct memberships save in one revision; ordered members append and history is preserved',t=>{
 const {store,a,b,ordered,plain}=fixture(t),before=store.version;
 const saved=store.editTerm(a.id,{...fields(a),scopeNote:'Updated with memberships',collections:[ordered.id,plain.id],expectedVersion:before});
 assert.equal(store.version,before+1);assert.equal(saved.changed,store.version);
 assert.deepEqual(store.conceptSet(ordered.id).members,[b.id,a.id]);assert.deepEqual(store.conceptSet(plain.id).members,[a.id]);
 const change=store.changes(before)[0];assert.equal(change.afterSets?.length,2);assert.ok(change.afterSets?.every(set=>set.changed===change.n));
 assert.equal(store.conceptSet(ordered.id).changed,saved.changed);
 assert.ok(store.termCollections(a.id).collections.filter(set=>set.direct).length===2);
 assert.ok(store.termCollections(a.id,before).collections.every(set=>!set.direct));
 const body=JSON.parse((store.db.prepare('SELECT body FROM terms WHERE id=?').get(a.id) as {body:string}).body);
 assert.ok(!('collections'in body));assert.ok(!('expectedVersion'in body));
 const n=store.version;store.editTerm(a.id,{...fields(saved),collections:[ordered.id],expectedVersion:n});
 assert.deepEqual(store.conceptSet(ordered.id).members,[b.id,a.id]);assert.equal(store.conceptSet(plain.id).members.length,0);assert.equal(store.changes(n)[0].breaking,true);
});

test('membership-only edits have history; computed and nested membership remain derived',t=>{
 const {store,a,ordered}=fixture(t);
 const recipe=store.saveSet({scheme:'subjects',slug:'recipe',label:'Recipe',recipe:{concepts:[a.id]}},store.version);
 const parent=store.saveSet({scheme:'subjects',slug:'parent',label:'Parent',members:[ordered.id]},store.version);
 const n=store.version;store.editTerm(a.id,{...fields(a),collections:[ordered.id],expectedVersion:n});
 assert.equal(store.changes(n)[0].kind,'set-changed');assert.equal(store.lookup(a.id).changed,n+1);
 const membership=store.termCollections(a.id).collections;
 assert.equal(membership.find(set=>set.id===parent.id)?.inherited,true);assert.equal(membership.find(set=>set.id===parent.id)?.direct,false);
 assert.equal(membership.find(set=>set.id===recipe.id)?.recipe,true);
 store.editTerm(a.id,{...fields(store.lookup(a.id)),collections:[],expectedVersion:store.version});
 assert.equal(store.termCollections(a.id).collections.find(set=>set.id===parent.id)?.included,false);
 assert.equal(store.termCollections(a.id).collections.find(set=>set.id===recipe.id)?.included,true);
});

test('stale or invalid collection edits roll back term fields and all collection assignments',t=>{
 const {store,a,ordered,plain}=fixture(t),before=store.version;
 const recipe=store.saveSet({scheme:'subjects',slug:'recipe',label:'Recipe',recipe:{}},store.version);
 store.addScheme({id:'other',label:'Other',hierarchy:'graph'});
 const other=store.saveSet({scheme:'other',slug:'other',label:'Other'},store.version);
 const version=store.version;
 for(const input of [
  {collections:[ordered.id],expectedVersion:before}, {collections:[recipe.id],expectedVersion:version},
  {collections:[other.id],expectedVersion:version}, {collections:['missing'],expectedVersion:version},
  {collections:[plain.id,plain.id],expectedVersion:version}, {collections:[ordered.id]},
 ]){
  assert.throws(()=>store.editTerm(a.id,{...fields(a),label:'Must not save',...input}));
  assert.equal(store.lookup(a.id).label,'A');assert.equal(store.version,version);assert.equal(store.conceptSet(plain.id).members.length,0);
 }
});

test('ordinary term edits do not overwrite collection changes when memberships are omitted',t=>{
 const {store,a,plain}=fixture(t);
 const {id:_id,created:_created,changed:_changed,...set}=plain;
 store.saveSet({...set,members:[a.id]},store.version,plain.id);
  assert.throws(()=>store.editTerm(a.id,{...fields(a),scopeNote:'Stale edit',expectedVersion:store.version-1}),/workspace changed/);
 store.editTerm(a.id,{...fields(a),scopeNote:'Independent field edit'});
 assert.deepEqual(store.conceptSet(plain.id).members,[a.id]);
});
