import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

// A scheme-wide concept graph, as quote-mcp keys concepts, and a tree whose slugs are unique only at depth 1.
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'human-work', label: 'Human work', hierarchy: 'graph', slugScope: 'scheme', proposalSource: 'optional' });
  const dialogue = store.addTerm({ scheme: 'human-work', label: 'Dialogue', status: 'active' });
  const conflict = store.addTerm({ scheme: 'human-work', label: 'Conflict', status: 'active', broader: [dialogue.id], aliases: ['quote-mcp:human-work:conflict'] });
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree', slugUniqueDepths: [1] });
  const humanities = store.addTerm({ scheme: 'subjects', label: 'Humanities' });
  const science = store.addTerm({ scheme: 'subjects', label: 'Science' });
  const history = store.addTerm({ scheme: 'subjects', label: 'History', broader: [humanities.id] });
  const physics = store.addTerm({ scheme: 'subjects', label: 'Physics', broader: [science.id] });
  // Depth 2 is unique only among siblings, so two terms share the slug "method".
  const historyMethod = store.addTerm({ scheme: 'subjects', label: 'Method', broader: [history.id] });
  const physicsMethod = store.addTerm({ scheme: 'subjects', label: 'Method', broader: [physics.id] });
  return { store, dialogue, conflict, humanities, history, physics, historyMethod, physicsMethod };
}

test('scheme:slug resolves after stable ID and alias, with former slugs, and each term has a key', t => {
  const { store, dialogue, conflict } = fixture(t);
  assert.equal(store.lookup('human-work:conflict').id, conflict.id);
  assert.deepEqual(store.resolve('human-work:conflict').via, 'slug');
  assert.equal(store.resolve(conflict.id).via, 'id');
  assert.equal(store.resolve('quote-mcp:human-work:conflict').via, 'alias');
  assert.equal(store.termKeys().key(store.lookup(conflict.id)), 'human-work:conflict');
  store.operate(conflict.id, { kind: 'slug', slug: 'strife', expectedVersion: store.version });
  const former = store.resolve('human-work:conflict');
  assert.equal(former.term.id, conflict.id); assert.equal(former.current, false);
  assert.equal(store.resolve('human-work:strife').current, true);
  assert.equal(store.termKeys().key(store.lookup(conflict.id)), 'human-work:strife');
  // A historical read resolves the slug the term had then.
  assert.equal(store.lookup('human-work:conflict', conflict.created).id, conflict.id);
  assert.throws(() => store.lookup('human-work:nothing'), /not found/);
  assert.throws(() => store.lookup('no-scheme:conflict'), /not found/);
  // A string that is an alias of one term and the scheme:slug of another resolves to the alias, and says so.
  const truce = store.addTerm({ scheme: 'human-work', label: 'Truce', aliases: ['human-work:strife'] });
  const shadowed = store.resolve('human-work:strife');
  assert.equal(shadowed.term.id, truce.id); assert.equal(shadowed.via, 'alias');
  assert.equal(shadowed.shadowed?.id, conflict.id);
  // The shadowed term's key then goes through its broader term's slug.
  assert.equal(shadowed.shadowed?.key, 'human-work:dialogue/strife');
  assert.equal(store.lookup('human-work:dialogue/strife').id, conflict.id);
});

test('a slug that repeats below its scheme-wide depth needs its parent slug or path, and the error names the candidates', t => {
  const { store, history, historyMethod, physicsMethod } = fixture(t);
  assert.equal(store.lookup('subjects:history').id, history.id);
  assert.throws(() => store.lookup('subjects:method'), (error: Error & { status?: number; details?: { reason: string; candidates: { id: string; key: string; path?: string }[] } }) => {
    assert.equal(error.status, 409); assert.match(error.message, /names 2 terms/);
    assert.equal(error.details?.reason, 'ambiguous-slug');
    assert.deepEqual(new Set(error.details?.candidates.map(c => c.key)), new Set(['subjects:history/method', 'subjects:physics/method']));
    assert.ok(error.details?.candidates.some(c => c.id === historyMethod.id && c.path === 'subjects:humanities/history/method'));
    return true;
  });
  assert.equal(store.lookup('subjects:history/method').id, historyMethod.id);
  assert.equal(store.lookup('subjects:physics/method').id, physicsMethod.id);
  assert.equal(store.lookup('subjects:humanities/history/method').id, historyMethod.id);
  assert.throws(() => store.lookup('subjects:humanities/method'), /not found/);
  assert.equal(store.termKeys().key(store.lookup(physicsMethod.id)), 'subjects:physics/method');
});

test('MCP tools take scheme:slug wherever a term is taken, return keys, and note an alias that shadows a slug', async t => {
  const { store, conflict, historyMethod } = fixture(t);
  const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new Client({ name: 'test', version: '1' });
  t.after(async () => { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent as T;
  };
  type Keyed = { id: string; key: string };
  const got = await call<{ term: Keyed; notices?: unknown }>('get_term', { ref: 'human-work:conflict' });
  assert.equal(got.term.id, conflict.id); assert.equal(got.term.key, 'human-work:conflict'); assert.equal(got.notices, undefined);
  const graph = await call<{ concepts: Keyed[] }>('get_graph', { around: 'human-work:dialogue', depth: 1 });
  assert.deepEqual(new Set(graph.concepts.map(c => c.key)), new Set(['human-work:dialogue', 'human-work:conflict']));
  assert.equal((await call<{ relationship: string; keys: { a: string } }>('subsumes', { a: 'human-work:dialogue', b: 'human-work:conflict' })).relationship, 'subsumes');
  const valid = await call<{ valid: boolean; id: string; key: string }>('validate_term', { ref: 'human-work:conflict' });
  assert.deepEqual([valid.valid, valid.id, valid.key], [true, conflict.id, 'human-work:conflict']);
  assert.equal((await call<{ valid: boolean }>('validate_term', { ref: 'human-work:nothing' })).valid, false);
  const collections = await call<{ id: string; key: string }>('get_term_collections', { ref: 'human-work:conflict' });
  assert.deepEqual([collections.id, collections.key], [conflict.id, 'human-work:conflict']);
  const hits = await call<{ items: Keyed[] }>('search_terms', { query: 'method' });
  assert.deepEqual(new Set(hits.items.map(h => h.key)), new Set(['subjects:history/method', 'subjects:physics/method']));
  assert.equal((await call<{ term: Keyed }>('get_term', { ref: 'subjects:history/method' })).term.id, historyMethod.id);
  const ambiguous = await client.callTool({ name: 'get_term', arguments: { ref: 'subjects:method' } });
  assert.equal(ambiguous.isError, true);
  assert.match(JSON.stringify(ambiguous.content), /subjects:history\/method.*subjects:physics\/method|subjects:physics\/method.*subjects:history\/method/);
  const proposed = await call<{ key: string; term: { broader: string[] } }>('propose_term', { scheme: 'human-work', broader: 'human-work:conflict',
    label: 'Blame', evidence: { quote: 1 }, proposer: 'test' });
  assert.deepEqual([proposed.key, proposed.term.broader], ['human-work:blame', [conflict.id]]);
  // The alias wins over the scheme:slug and the answer says which term the slug would have named.
  const truce = store.addTerm({ scheme: 'human-work', label: 'Truce', aliases: ['human-work:conflict'] });
  const shadow = await call<{ term: Keyed; notices: { ref: string; message: string }[] }>('get_term', { ref: 'human-work:conflict' });
  assert.equal(shadow.term.id, truce.id);
  assert.equal(shadow.notices[0].ref, 'human-work:conflict');
  assert.match(shadow.notices[0].message, /alias of Truce.*would name Conflict, reachable as human-work:dialogue\/conflict/);
});
