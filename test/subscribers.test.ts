import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { planSkos, exportSkos } from '../src/skos.js';

// A three-level tree like cc-subjects: domains, categories, subcategories.
function subjects(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'cc-subjects', label: 'Subjects', hierarchy: 'tree', slugUniqueDepths: [0, 1] });
  const domain = store.addTerm({ scheme: 'cc-subjects', label: 'Sciences', status: 'active' });
  const other = store.addTerm({ scheme: 'cc-subjects', label: 'Humanities', status: 'active' });
  const category = store.addTerm({ scheme: 'cc-subjects', label: 'Geography', broader: [domain.id], status: 'active' });
  const sub = store.addTerm({ scheme: 'cc-subjects', label: 'Hydrology', broader: [category.id], status: 'active' });
  return { store, domain, other, category, sub };
}
async function serve(t: test.TestContext, store: Store) {
  const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (method: string, path: string, data?: unknown) => {
    const res = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: res.status, body: await res.json() };
  };
  return { origin, send };
}

test('a scheme’s maximum depth is a versioned setting enforced on every write', t => {
  const { store, domain, category, sub } = subjects(t);
  const before = store.version;
  assert.throws(() => store.updateScheme('cc-subjects', { maxDepth: 1, expectedVersion: store.version }), /Hydrology.*depth 2/);
  const scheme = store.updateScheme('cc-subjects', { maxDepth: 2, expectedVersion: store.version });
  assert.equal(scheme.maxDepth, 2);
  assert.equal(store.version, before + 1);
  const change = store.changes(before, undefined, 'cc-subjects').at(-1)!;
  assert.deepEqual([change.kind, change.breaking, (change.after as { maxDepth?: number }).maxDepth], ['scheme-changed', false, 2]);
  assert.equal(store.schemes(before)[0].maxDepth, undefined);
  assert.equal(store.schemes()[0].maxDepth, 2);
  assert.throws(() => store.addTerm({ scheme: 'cc-subjects', label: 'Too deep', broader: [sub.id] }), /depth 3.*only to depth 2/);
  const sibling = store.addTerm({ scheme: 'cc-subjects', label: 'Climate', broader: [domain.id] });
  assert.throws(() => store.operate(category.id, { kind: 'move', broader: [sibling.id], expectedVersion: store.version }), /depth 3/);
  assert.throws(() => store.updateScheme('cc-subjects', { maxDepth: 2, expectedVersion: before }), /workspace changed/);
  // Retired terms are read-only and keep their place, so they don't block a lower limit.
  store.operate(sub.id, { kind: 'retire', replacements: [], expectedVersion: store.version });
  assert.equal(store.updateScheme('cc-subjects', { maxDepth: 1, expectedVersion: store.version }).maxDepth, 1);
  assert.equal(store.updateScheme('cc-subjects', { maxDepth: null, expectedVersion: store.version }).maxDepth, undefined);
  const limnology = store.addTerm({ scheme: 'cc-subjects', label: 'Limnology', broader: [category.id] });
  assert.ok(store.addTerm({ scheme: 'cc-subjects', label: 'Now allowed', broader: [limnology.id] }));
});

test('maximum depth round-trips through SKOS', async t => {
  const { store } = subjects(t);
  store.updateScheme('cc-subjects', { maxDepth: 2, expectedVersion: store.version });
  const copy = new Store(':memory:'); t.after(() => copy.close());
  const plan = planSkos(copy, await exportSkos(store, 'cc-subjects'),
    { format: 'turtle', sourceScheme: 'urn:terminology-mcp:scheme:cc-subjects', schemeId: 'copy', language: 'en', hierarchy: 'auto' }).plan;
  copy.importScheme(plan, 0);
  assert.equal(copy.schemes()[0].maxDepth, 2);
});

test('v3 stores gain versioned schemes and an empty subscriber list on open', t => {
  const directory = mkdtempSync(join(tmpdir(), 'terminology-v3-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'old.sqlite');
  let store = new Store(filename);
  store.addScheme({ id: 'cc-subjects', label: 'Subjects', hierarchy: 'tree' });
  store.addTerm({ scheme: 'cc-subjects', label: 'Sciences' });
  const log = store.logId; store.close();
  const db = new Database(filename); db.exec('DROP TABLE scheme_revisions; DROP TABLE subscribers; PRAGMA user_version = 3;'); db.close();
  store = new Store(filename); t.after(() => store.close());
  assert.equal(store.logId, log);
  assert.deepEqual(store.schemes(1).map(scheme => scheme.id), ['cc-subjects']);
  assert.deepEqual(store.schemes(0), []);
  assert.deepEqual(store.subscribers(), []);
  assert.equal(store.updateScheme('cc-subjects', { maxDepth: 0, expectedVersion: store.version }).maxDepth, 0);
});

test('proposals create provisional terms with a slug, and refuse duplicates with the existing term', async t => {
  const { store, domain, category, sub } = subjects(t);
  store.updateScheme('cc-subjects', { maxDepth: 2, expectedVersion: store.version });
  const { send } = await serve(t, store);
  const proposal = { scheme: 'cc-subjects', label: 'Glaciology', broader: 'geography', proposer: 'concept-clusters:authoring',
    evidence: { draftId: 'd-17' }, requestId: 'r-1' };
  const created = await send('POST', '/api/proposals', proposal);
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.slug, created.body.status, created.body.change, created.body.replayed], ['glaciology', 'provisional', store.version, false]);
  assert.deepEqual(created.body.term.broader, [category.id]);
  const change = store.changes(store.version - 1)[0];
  assert.deepEqual([change.kind, change.author, change.breaking, change.proposal], ['added', 'concept-clusters:authoring', false,
    { proposer: 'concept-clusters:authoring', evidence: { draftId: 'd-17' }, requestId: 'r-1' }]);
  assert.deepEqual(store.lookup(created.body.id).aliases, ['cc-subjects:sciences/geography/glaciology']);

  const replay = await send('POST', '/api/proposals', { ...proposal, label: 'Ignored on replay' });
  assert.deepEqual([replay.status, replay.body.id, replay.body.replayed], [200, created.body.id, true]);
  const head = store.version;

  const duplicate = await send('POST', '/api/proposals', { ...proposal, requestId: 'r-2', label: 'Hydrology' });
  assert.equal(duplicate.status, 409);
  assert.deepEqual([duplicate.body.reason, duplicate.body.existing.id, duplicate.body.existing.slug, duplicate.body.existing.status],
    ['duplicate', sub.id, 'hydrology', 'active']);
  // Categories are unique across the scheme, so a category slug under another domain is a duplicate too.
  const wide = await send('POST', '/api/proposals', { ...proposal, requestId: 'r-3', label: 'Geography', broader: 'humanities' });
  assert.deepEqual([wide.status, wide.body.existing.id], [409, category.id]);
  const hinted = await send('POST', '/api/proposals', { ...proposal, requestId: 'r-4', label: 'Human Geography', broader: 'humanities', slug: 'human-geography' });
  assert.equal(hinted.status, 201);
  store.operate(sub.id, { kind: 'retire', replacements: [], expectedVersion: store.version });
  const retired = await send('POST', '/api/proposals', { ...proposal, requestId: 'r-5', label: 'Hydrology' });
  assert.deepEqual([retired.status, retired.body.reason, retired.body.existing.status], [409, 'retired', 'retired']);

  const tooDeep = await send('POST', '/api/proposals', { ...proposal, requestId: 'r-6', label: 'Ice Cores', broader: created.body.id });
  assert.deepEqual([tooDeep.status, /depth 3/.test(tooDeep.body.error)], [422, true]);
  assert.equal((await send('POST', '/api/proposals', { ...proposal, proposer: undefined, requestId: 'r-7', label: 'Karst' })).status, 422);
  assert.equal((await send('POST', '/api/proposals', { ...proposal, requestId: 'r-8', label: 'Karst', broader: 'nowhere' })).status, 404);
  assert.equal((await send('POST', '/api/proposals', { ...proposal, requestId: 'r-9', label: 'Karst', scheme: 'missing' })).status, 404);
  assert.equal(store.version, head + 2);
  assert.ok(store.lookup(domain.id));
});

test('subscribers report progress; pending counts follow their schemes and holds carry a code', async t => {
  const { store, domain, category, sub } = subjects(t);
  store.addScheme({ id: 'loc', label: 'LCC', hierarchy: 'poly' });
  const { send } = await serve(t, store);
  const head = store.version;
  const report = (data: Record<string, unknown>) => send('POST', '/api/subscribers/concept-clusters/progress',
    { log: store.logId, label: 'Concept Clusters', schemes: ['cc-subjects'], ...data });
  const first = await report({ through: head });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.through, first.body.pending, first.body.blocked, first.body.registered === first.body.lastSeen], [head, 0, null, true]);
  assert.equal(store.version, head);

  store.addTerm({ scheme: 'loc', label: 'Elsewhere' });
  const renamed = store.editTerm(domain.id, { label: 'The Sciences', status: 'active', expectedChanged: domain.changed });
  const slugged = store.operate(domain.id, { kind: 'slug', slug: 'science', expectedVersion: store.version });
  let view = (await send('GET', '/api/subscribers/concept-clusters')).body;
  // The rename also re-derives the descendants' paths, so they are pending too.
  assert.deepEqual([view.pending, view.pendingBreaking, view.pendingTerms.sort(), view.head], [2, 2, [domain.id, category.id, sub.id].sort(), store.version]);

  const held = await send('POST', '/api/subscribers/concept-clusters/progress',
    { log: store.logId, through: renamed.changed, blocked: { at: slugged.version, code: 'slug-change', reason: 'Slug in 40 player URLs' } });
  assert.deepEqual([held.body.through, held.body.pending, held.body.blocked, held.body.schemes, held.body.label],
    [renamed.changed, 1, { at: slugged.version, code: 'slug-change', reason: 'Slug in 40 player URLs' }, ['cc-subjects'], 'Concept Clusters']);
  const list = (await send('GET', '/api/subscribers')).body;
  assert.deepEqual([list.log, list.subscribers.map((s: { id: string }) => s.id)], [store.logId, ['concept-clusters']]);

  assert.equal((await report({ through: head })).status, 409);
  assert.equal((await report({ through: head, reset: true })).body.through, head);
  view = (await report({ through: store.version })).body;
  assert.deepEqual([view.pending, view.blocked], [0, null]);
  assert.equal((await report({ through: store.version + 1 })).status, 400);
  const stale = await report({ through: 0, log: 'another-log' });
  assert.deepEqual([stale.status, stale.body.log], [409, store.logId]);
  assert.equal((await report({ through: 1, reset: true, blocked: { at: 1 } })).status, 422);
  assert.equal((await report({ through: 1, schemes: ['missing'] })).status, 404);
  assert.equal((await send('POST', '/api/subscribers/Bad_Id/progress', { log: store.logId, through: 0 })).status, 422);
  assert.equal((await send('GET', '/api/subscribers/nobody')).status, 404);
});

test('MCP propose_term and list_subscribers', async t => {
  const { store } = subjects(t);
  const { origin } = await serve(t, store);
  const client = new Client({ name: 'test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  const proposed = await client.callTool({ name: 'propose_term', arguments: {
    scheme: 'cc-subjects', label: 'Oceanography', broader: 'geography', proposer: 'agent:test', requestId: 'x' } });
  assert.ok(!proposed.isError, JSON.stringify(proposed));
  const result = proposed.structuredContent as { id: string; slug: string; status: string };
  assert.deepEqual([result.slug, result.status], ['oceanography', 'provisional']);
  assert.equal(store.changes(store.version - 1)[0].author, 'agent:test');
  const duplicate = await client.callTool({ name: 'propose_term', arguments: {
    scheme: 'cc-subjects', label: 'Oceanography', broader: 'geography', proposer: 'agent:other' } });
  assert.equal(duplicate.isError, true);
  assert.match(JSON.stringify(duplicate.content), new RegExp(result.id));
  store.reportProgress('concept-clusters', { log: store.logId, through: 1 });
  const listed = await client.callTool({ name: 'list_subscribers', arguments: {} });
  const subscribers = (listed.structuredContent as { subscribers: { id: string; pending: number }[] }).subscribers;
  assert.deepEqual(subscribers.map(s => [s.id, s.pending]), [['concept-clusters', store.version - 1]]);
});
