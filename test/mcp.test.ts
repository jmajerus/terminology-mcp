import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import type { TermView, Change, Scheme, ConceptSet } from '../src/model.js';
import type { GraphEdge } from '../src/graph.js';

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.addScheme({ id: 'network', label: 'Network', hierarchy: 'graph' });
  const a = store.addTerm({ scheme: 'network', label: 'Alpha', status: 'active', aliases: ['old-alpha'] });
  const b = store.addTerm({ scheme: 'network', label: 'Beta', altLabels: ['Βήτα'], broader: [a.id], notations: [{ value: 'B42' }] });
  const c = store.addTerm({ scheme: 'network', label: 'Gamma', broader: [a.id, b.id], relations: [{ type: 'opposite', target: a.id }] });
  store.addScheme({ id: 'external', label: 'External', hierarchy: 'tree' });
  const other = store.addTerm({ scheme: 'external', label: 'Outside', relations: [{ type: 'related', target: a.id }] });
  const set = store.saveSet({ scheme: 'network', slug: 'ordered', label: 'Ordered', ordered: true, members: [c.id, a.id] }, store.version);
  const nested = store.saveSet({ scheme: 'network', slug: 'nested', label: 'Nested', members: [set.id] }, store.version);
  const recipe = store.saveSet({ scheme: 'network', slug: 'recipe', label: 'Recipe', recipe: { narrower: [a.id] } }, store.version);
  const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(result.structuredContent, JSON.parse((result.content as {text:string}[])[0].text));
    return result.structuredContent as T;
  };
  const error = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), pattern);
  };
  return { store, a, b, c, other, set, nested, recipe, server, client, url, call, error };
}
type Page<T> = { version: number; total: number; items: T[]; nextOffset: number | null };

test('MCP discovery and search work over stateless HTTP with validated paging and snapshot versions', async t => {
  const { store, client, call, error } = await fixture(t), before = store.version;
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  for (const tool of tools.filter(tool => tool.name !== 'propose_term'))
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(tools.find(tool => tool.name === 'propose_term')?.annotations?.readOnlyHint, false);
  assert.ok(!tools.some(tool => /apply|edit|delete|create|import/.test(tool.name)));
  const first = await call<Page<Scheme>>('list_schemes', { limit: 1 });
  store.addScheme({ id: 'later', label: 'Later', hierarchy: 'poly' });
  const second = await call<Page<Scheme>>('list_schemes', { limit: 1, offset: first.nextOffset, at: first.version });
  assert.equal(second.total, 2); assert.equal(second.nextOffset, null); assert.notEqual(first.items[0].id, second.items[0].id);
  for (const query of ['ALPHA', 'old-alpha', 'b42', 'βήτα']) assert.equal((await call<Page<TermView>>('search_terms', { query })).total, 1);
  assert.equal((await call<Page<TermView>>('search_terms', { scheme: 'network', limit: 1 })).nextOffset, 1);
  await error('search_terms', { limit: 201 }, /Invalid|validation|Too big/i);
  await error('search_terms', { unexpected: 'field' }, /Invalid|validation|Unrecognized/i);
  await error('get_graph', { depth: 6 }, /Invalid|validation|Too big/i);
  await error('list_schemes', { at: store.version + 1 }, /Version/);
  assert.equal(store.version, before + 1);
});

test('MCP lookup, typed graph traversal and subsumption preserve multiple parents and cross-scheme connections', async t => {
  const { store, a, b, c, other, call } = await fixture(t), before = store.version;
  const term = await call<{term:TermView;connections:{type:string;target:string}[]}>('get_term', { ref: 'old-alpha' });
  assert.equal(term.term.id, a.id);
  assert.ok(term.connections.some(e => e.type === 'related' && e.target === other.id));
  assert.ok(term.connections.some(e => e.type === 'narrower' && e.target === c.id));
  assert.ok(term.connections.some(e => e.type === 'opposite' && e.target === c.id));
  const graph = await call<{concepts:TermView[];relations:GraphEdge[]}>('get_graph', { around: c.id, depth: 1, types: ['broader'] });
  assert.deepEqual(new Set(graph.concepts.map(t => t.id)), new Set([a.id, b.id, c.id]));
  assert.ok(graph.relations.every(e => e.type === 'broader'));
  const only = await call<{concepts:TermView[]}>('get_graph', { around: c.id, depth: 0 });
  assert.deepEqual(only.concepts.map(t => t.id), [c.id]);
  for (const [x,y,expected] of [[a.id,c.id,'subsumes'],[c.id,a.id,'subsumed-by'],[a.id,a.id,'equivalent'],[a.id,other.id,'not-subsumed']])
    assert.equal((await call<{relationship:string}>('subsumes', { a:x,b:y })).relationship, expected);
  assert.equal(store.version, before);
});

test('MCP collections preserve order, derived membership, historical definitions and graph selections', async t => {
  const { store, a, b, c, set, nested, recipe, call, error } = await fixture(t), before = store.version;
  const listed = await call<Page<ConceptSet>>('list_sets', { scheme: 'network' }); assert.equal(listed.total, 3);
  assert.equal((await call<{set:ConceptSet}>('get_set', { id:set.id })).set.ordered, true);
  const first = await call<Page<TermView>>('expand_set', { id: set.id, limit: 1 });
  assert.deepEqual(first.items.map(t=>t.id), [c.id]);
  assert.deepEqual((await call<Page<TermView>>('expand_set', { id:set.id,at:first.version,offset:first.nextOffset })).items.map(t=>t.id), [a.id]);
  assert.deepEqual(new Set((await call<Page<TermView>>('expand_set', { id:recipe.id })).items.map(t=>t.id)), new Set([b.id,c.id]));
  const memberships = await call<Page<{id:string;direct:boolean;inherited:boolean;included:boolean}>>('get_term_collections', { ref:a.id });
  assert.equal(memberships.items.find(s=>s.id===set.id)?.direct,true);
  assert.equal(memberships.items.find(s=>s.id===nested.id)?.inherited,true);
  assert.equal(memberships.items.find(s=>s.id===recipe.id)?.included,false);
  assert.equal((await call<Page<TermView>>('search_terms',{set:set.id})).total,2);
  const graph = await call<{concepts:TermView[]}>('get_graph',{set:set.id});assert.deepEqual(new Set(graph.concepts.map(t=>t.id)),new Set([a.id,c.id]));
  await error('search_terms',{set:set.id,scheme:'external'},/different scheme/);
  await error('list_sets',{scheme:'missing'},/Scheme not found/);
  store.deleteSet(recipe.id, store.version);
  await error('get_set',{id:recipe.id},/Concept set not found/);
  assert.equal((await call<{set:ConceptSet}>('get_set',{id:recipe.id,at:before})).set.id,recipe.id);
  assert.equal((await call<Page<TermView>>('expand_set',{id:recipe.id,at:before})).total,2);
});

test('MCP validation reports unknown, retired, provisional and out-of-set terms without writes', async t => {
  const { store, a, b, set, call, error } = await fixture(t);
  const replacement = store.addTerm({scheme:'network',label:'Replacement'}), before=store.version;
  assert.equal((await call<{valid:boolean}>('validate_term',{ref:b.id})).valid,true);
  assert.equal((await call<{reason:string}>('validate_term',{ref:b.id,set:set.id})).reason,'outside-set');
  assert.equal((await call<{reason:string}>('validate_term',{ref:'missing'})).reason,'unknown-term');
  await error('validate_term',{ref:'missing',set:'missing'},/Concept set not found/);
  store.operate(a.id,{kind:'retire',expectedVersion:store.version,replacements:[replacement.id]});
  const retired=await call<{valid:boolean;reason:string;replacedBy:string[]}>('validate_term',{ref:'old-alpha',set:set.id});
  assert.equal(retired.valid,false);assert.equal(retired.reason,'retired');assert.deepEqual(retired.replacedBy,[replacement.id]);
  assert.equal((await call<{valid:boolean}>('validate_term',{ref:a.id,at:before})).valid,true);
  assert.equal((await call<Page<TermView>>('search_terms',{query:'Alpha'})).total,0);
  assert.equal((await call<Page<TermView>>('search_terms',{query:'Alpha',status:'retired'})).total,1);
  assert.equal(store.version,before+1);
});

test('MCP changes catch up without gaps while later writes are excluded from the snapshot; SKOS is versioned', async t => {
  const {store,a,call,error}=await fixture(t), before=store.version;
  const first=await call<{version:number;items:Change[];nextSince:number}>('get_changes',{limit:2});
  store.addTerm({scheme:'network',label:'Later'});
  const numbers=first.items.map(c=>c.n);let since:number|null=first.nextSince;
  while (since !== null) {
    const next: {items: Change[]; nextSince: number | null} = await call('get_changes', {since, limit: 2, at: first.version});
    numbers.push(...next.items.map(c => c.n)); since = next.nextSince;
  }
  assert.deepEqual(numbers,Array.from({length:before},(_,i)=>i+1));
  assert.ok(!('after' in first.items[0]));
  const full = await call<{items: Change[]}>('get_changes', {limit: 1, includeSnapshots: true});
  assert.equal(full.items[0].after.id, 'network');
  const empty = await call<{nextSince:null;through:number}>('get_changes', {since: before, at: before});
  assert.equal(empty.nextSince, null); assert.equal(empty.through, before);
  const filtered=await call<{items:Change[]}>('get_changes',{term:a.id,at:before});assert.ok(filtered.items.every(c=>c.terms.includes(a.id)));
  await error('get_changes',{since:store.version,at:before},/since cannot exceed/);
  const scoped = await call<{log: string; items: Change[]}>('get_changes', {scheme: 'external', at: before, limit: 200});
  assert.equal(scoped.log, store.logId);
  assert.deepEqual(scoped.items.map(c => c.n), store.changes(0, undefined, 'external').filter(c => c.n <= before).map(c => c.n));
  assert.ok(scoped.items.length > 0 && !scoped.items.some(c => c.n === 2));
  await error('get_changes', {scheme: 'missing'}, /Scheme not found/);
  const skos=await call<{version:number;mediaType:string;data:string}>('export_skos',{scheme:'network',at:before});
  assert.equal(skos.version,before);assert.equal(skos.mediaType,'text/turtle');assert.match(skos.data,/OrderedCollection/);assert.match(skos.data,/notation/);assert.doesNotMatch(skos.data,/Later/);
  await error('get_term',{ref:'missing'},/Term not found/);
  await error('get_term',{ref:a.id,at:0},/Term not found/);
  await error('export_skos',{scheme:'missing'},/Scheme not found/);
});

test('MCP refuses oversized graph/results rather than silently truncating; repeated calls leave the store usable', async t => {
  const {store,call,error}=await fixture(t);
  for(let i=0;i<201;i++)store.addTerm({scheme:'external',label:`Large ${i}`,scopeNote:'x'.repeat(20000)});
  const version=store.version;
  await error('get_graph',{scheme:'external'},/exceeds 200/);
  await error('search_terms',{scheme:'external',limit:200},/exceeds 1 MiB/);
  assert.equal((await call<Page<TermView>>('search_terms',{scheme:'external',limit:1})).items.length,1);
  assert.equal(store.version,version);
});

test('every MCP tool works with SQLite query_only enabled and does not alter the changelog', async t => {
  const { store, a, b, set, call } = await fixture(t), version = store.version;
  store.db.pragma('query_only = ON');
  const calls: [string, Record<string, unknown>][] = [
    ['list_schemes', {}], ['search_terms', { query: 'Alpha' }], ['get_term', { ref: a.id }],
    ['get_graph', { around: a.id }], ['list_sets', {}], ['get_set', { id: set.id }],
    ['expand_set', { id: set.id }], ['get_term_collections', { ref: a.id }],
    ['validate_term', { ref: a.id, set: set.id }], ['subsumes', { a: a.id, b: b.id }],
    ['get_changes', {}], ['export_skos', { scheme: 'network' }],
  ];
  for (const [name, args] of calls) {
    const result = await call<{ version: number }>(name, args);
    assert.equal(result.version, version, name);
  }
  assert.equal(store.version, version);
});

test('MCP HTTP enforces host/origin protections, content type, size limits and stateless methods', async t => {
  const {url,server,store}=await fixture(t), before=store.version;
  const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const post=(body:string,extra={})=>fetch(url,{method:'POST',headers:{...headers,...extra},body});
  for(const method of ['GET','DELETE','OPTIONS'])assert.equal((await fetch(url,{method})).status,405);
  assert.equal((await post(JSON.stringify(init),{Origin:'https://evil.example'})).status,403);
  assert.equal((await post(JSON.stringify(init),{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post(JSON.stringify(init),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('{')).status,400);
  assert.equal((await post('x'.repeat(128*1024+1))).status,413);
  const invalidHost=await new Promise<number|undefined>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:(server.address() as AddressInfo).port,path:'/mcp',method:'POST',headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify(init));
  });assert.equal(invalidHost,403);
  const response=await post(JSON.stringify(init));assert.equal(response.status,200);assert.equal(response.headers.get('mcp-session-id'),null);
  assert.ok((await response.json()).result.capabilities.tools);assert.equal(store.version,before);
});
