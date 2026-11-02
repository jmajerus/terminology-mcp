import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { planGraph } from '../src/graph-import.js';
import { conceptGraph } from '../src/graph.js';
import { importRequestSchema, exportSkos, planSkos } from '../src/skos.js';

// quote-mcp's concept scheme: slugs it keys URLs on, one that differs from its label, and a concept with two broader ones.
const sample = JSON.stringify({ format: 'quote-mcp-export/1', schemes: [{ id: 1, slug: 'human-work', label: 'Human work' }], concepts: [
  { id: 1, scheme: 'human-work', slug: 'psychic-prison', label: 'psychic prison', status: 'confirmed' },
  { id: 2, scheme: 'human-work', slug: 'organizational-psychodynamics', label: 'organizational psychodynamics', status: 'confirmed' },
  { id: 3, scheme: 'human-work', slug: 'isolated', label: 'Disconnected concept', status: 'confirmed' },
  { id: 4, scheme: 'human-work', slug: 'job-loss', label: 'Job loss', status: 'confirmed' },
], relations: [{ from: 'psychic-prison', to: 'organizational-psychodynamics', type: 'broader' }] });
const quoteRequest = () => importRequestSchema.parse({ format: 'graph-json', sourceScheme: 'urn:quote-mcp:scheme:human-work', schemeId: 'human-work', hierarchy: 'graph' });
function humanWork(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.importScheme(planGraph(store, sample, quoteRequest()).plan, 0);
  const concept = (slug: string) => store.lookup(`quote-mcp:human-work:${slug}`);
  return { store, concept };
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

test('a quote-mcp import keeps its slugs, and makes them unique across the scheme with evidence-backed proposals', t => {
  const { store, concept } = humanWork(t);
  assert.equal(concept('isolated').slug, 'isolated');
  assert.equal(concept('psychic-prison').slug, 'psychic-prison');
  const scheme = store.schemes()[0];
  assert.deepEqual([scheme.slugScope, scheme.proposalSource], ['scheme', 'optional']);
  // A concept under another broader one still can't take a slug in use elsewhere in the scheme.
  assert.throws(() => store.addTerm({ scheme: 'human-work', label: 'Job loss', slug: 'job-loss', broader: [concept('psychic-prison').id], status: 'active' }),
    /already used in this scheme/);
  assert.equal(store.addTerm({ scheme: 'human-work', label: 'Job loss', broader: [concept('psychic-prison').id], status: 'active' }).slug, 'job-loss-2');
});

test('the native graph format carries slugs, former slugs and the scheme settings', t => {
  const { store, concept } = humanWork(t);
  store.operate(concept('job-loss').id, { kind: 'slug', slug: 'losing-a-job', expectedVersion: store.version });
  const copy = new Store(':memory:'); t.after(() => copy.close());
  const exported = JSON.stringify(conceptGraph(store, { scheme: 'human-work' }));
  copy.importScheme(planGraph(copy, exported, importRequestSchema.parse({ format: 'graph-json', sourceScheme: 'urn:quote-mcp:scheme:human-work',
    schemeId: 'copy', hierarchy: 'graph' })).plan, 0);
  const moved = copy.terms().find(term => term.label === 'Job loss')!;
  assert.deepEqual([moved.slug, moved.formerSlugs], ['losing-a-job', ['job-loss']]);
  assert.deepEqual([copy.schemes()[0].slugScope, copy.schemes()[0].proposalSource], ['scheme', 'optional']);
});

test('slug scope and proposal source are versioned settings; a wider slug scope needs unique slugs', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  // Sibling-scoped slugs may repeat across branches; former slugs stay reserved, so a slug change doesn't free one.
  const branches = (scheme: string, second?: string) => {
    store.addScheme({ id: scheme, label: scheme, hierarchy: 'graph' });
    const a = store.addTerm({ scheme, label: 'Work', status: 'active' });
    const b = store.addTerm({ scheme, label: 'Play', status: 'active' });
    store.addTerm({ scheme, label: 'Flow', broader: [a.id], status: 'active' });
    store.addTerm({ scheme, label: 'Flow', broader: [b.id], status: 'active', ...(second ? { slug: second } : {}) });
  };
  branches('clash');
  assert.throws(() => store.updateScheme('clash', { slugScope: 'scheme', expectedVersion: store.version }), /“flow” is already used in this scheme/);
  branches('themes', 'flow-in-play');
  const before = store.version;
  const scheme = store.updateScheme('themes', { slugScope: 'scheme', proposalSource: 'optional', expectedVersion: store.version });
  assert.deepEqual([scheme.slugScope, scheme.proposalSource], ['scheme', 'optional']);
  const [change] = store.changes(before);
  assert.deepEqual([change.kind, change.breaking], ['scheme-changed', false]);
  assert.match(change.reason, /Slugs unique across the scheme; Proposals may cite evidence/);
  assert.equal(store.schemes(before).find(s => s.id === 'themes')!.slugScope, undefined);
  // Leaving settings out keeps them; a call that changes nothing logs nothing.
  assert.equal(store.updateScheme('themes', { maxDepth: 3, expectedVersion: store.version }).slugScope, 'scheme');
  const settled = store.version;
  store.updateScheme('themes', { slugScope: 'scheme', expectedVersion: store.version });
  assert.equal(store.version, settled);
  assert.throws(() => store.addScheme({ id: 'mixed', label: 'Mixed', hierarchy: 'tree', slugUniqueDepths: [0], slugScope: 'scheme' }), /slug depths/);
});

test('slug scope and proposal source round-trip through SKOS', async t => {
  const { store } = humanWork(t);
  const copy = new Store(':memory:'); t.after(() => copy.close());
  copy.importScheme(planSkos(copy, await exportSkos(store, 'human-work'),
    { format: 'turtle', sourceScheme: 'urn:quote-mcp:scheme:human-work', schemeId: 'copy', language: 'en', hierarchy: 'auto' }).plan, 0);
  assert.deepEqual([copy.schemes()[0].slugScope, copy.schemes()[0].proposalSource], ['scheme', 'optional']);
});

test('a graph scheme takes proposals backed by evidence, with or without a broader concept', async t => {
  const { store, concept } = humanWork(t);
  const { send } = await serve(t, store);
  const evidence = { quote: 412, text: 'Flexibility is demanded of every worker.', tag: 'flexiblity' };
  const top = await send('POST', '/api/proposals', { scheme: 'human-work', label: 'Flexibility', evidence, proposer: 'quote-mcp', requestId: 'tag:flexiblity' });
  assert.equal(top.status, 201, JSON.stringify(top.body));
  assert.deepEqual([top.body.slug, top.body.status, top.body.term.broader, top.body.term.links, top.body.term.source],
    ['flexibility', 'provisional', [], [], undefined]);
  const [added] = store.changes(store.version - 1);
  assert.deepEqual([added.kind, added.proposal?.evidence, added.proposal?.source], ['added', evidence, undefined]);
  const under = await send('POST', '/api/proposals', { scheme: 'human-work', label: 'Care work', broader: 'psychic-prison', evidence: { quote: 7 }, proposer: 'quote-mcp' });
  assert.equal(under.status, 201);
  assert.deepEqual(under.body.term.broader, [concept('psychic-prison').id]);
  // A slug in use anywhere in the scheme is a duplicate, with the existing term.
  const clash = await send('POST', '/api/proposals', { scheme: 'human-work', label: 'Job loss', broader: 'psychic-prison', evidence: { quote: 9 }, proposer: 'quote-mcp' });
  assert.deepEqual([clash.status, clash.body.reason, clash.body.existing.id], [409, 'duplicate', concept('job-loss').id]);
  const bare = await send('POST', '/api/proposals', { scheme: 'human-work', label: 'Care', proposer: 'quote-mcp' });
  assert.equal(bare.status, 422); assert.match(bare.body.error, /source or evidence/);
  const unnamed = await send('POST', '/api/proposals', { scheme: 'human-work', evidence: { quote: 1 }, proposer: 'quote-mcp' });
  assert.equal(unnamed.status, 422); assert.match(unnamed.body.error, /Pass label/);
});

test('without the setting, a proposal still needs a source, and a tree proposal a broader term', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  store.addScheme({ id: 'themes', label: 'Themes', hierarchy: 'graph' });
  const { send } = await serve(t, store);
  const tree = await send('POST', '/api/proposals', { scheme: 'subjects', label: 'Care', evidence: { quote: 1 }, proposer: 'quote-mcp' });
  assert.equal(tree.status, 422); assert.match(tree.body.error, /Pass broader/);
  const graph = await send('POST', '/api/proposals', { scheme: 'themes', label: 'Care', evidence: { quote: 1 }, proposer: 'quote-mcp' });
  assert.equal(graph.status, 422); assert.match(graph.body.error, /Pass source: search a reference vocabulary/);
});

test('MCP propose_term takes evidence instead of a source where the scheme allows it', async t => {
  const { store } = humanWork(t);
  const { origin } = await serve(t, store);
  const client = new Client({ name: 'test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp')));
  const proposed = await client.callTool({ name: 'propose_term', arguments: {
    scheme: 'human-work', label: 'Conspiracy theory', evidence: { quote: 88 }, proposer: 'quote-mcp:agent' } });
  assert.ok(!proposed.isError, JSON.stringify(proposed));
  assert.equal((proposed.structuredContent as { slug: string }).slug, 'conspiracy-theory');
});

test('switching a tree with slug depths to scheme-wide slugs drops the depths', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree', slugUniqueDepths: [0, 1] });
  const domain = store.addTerm({ scheme: 'subjects', label: 'Sciences', status: 'active' });
  store.addTerm({ scheme: 'subjects', label: 'Geography', broader: [domain.id], status: 'active' });
  const before = store.version;
  const scheme = store.updateScheme('subjects', { slugScope: 'scheme', expectedVersion: store.version });
  assert.deepEqual([scheme.slugScope, scheme.slugUniqueDepths], ['scheme', []]);
  assert.match(store.changes(before)[0].reason, /replacing the slug depths 0, 1/);
  assert.deepEqual(store.schemes(before)[0].slugUniqueDepths, [0, 1]);
});
