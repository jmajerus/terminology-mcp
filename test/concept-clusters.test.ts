import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { ccConfig, ccLookup, ccParts, ccSearch, lookupQuery, searchQuery, searchStems, type CcConfig } from '../src/concept-clusters.js';

const P = 'urn:concept-clusters:puzzle:moral-inversion', CLUSTER = `${P}#inverting-moral-value`;
const config: CcConfig = { baseUrl: 'http://cc.test', site: 'https://cc.example/', timeoutMs: 1000 };
const v = (value: string) => ({ value });
const VOCAB = 'https://concept-clusters.org/vocab#';
const clusterRows = ['cruelty as strength', 'empathy as weakness'].map(member => ({ title: v('Moral inversion'), type: v(VOCAB + 'Cluster'),
  name: v('Inverting moral value'), text: v('Cruelty is treated as admirable.'), member: v(member) }));
const answering = (bindings: unknown[], calls: string[] = []) => (async (_url: unknown, init?: RequestInit) => {
  calls.push(String(new URLSearchParams(String(init?.body)).get('query')));
  return new Response(JSON.stringify({ results: { bindings } }), { status: 200 });
}) as typeof fetch;

test('ccConfig: unset means the LAN server and the public player site, off turns lookups off', () => {
  assert.deepEqual(ccConfig({}), { baseUrl: 'http://oxigraph.localdomain:7878', site: 'https://concept-clusters.jmajerus.workers.dev/', timeoutMs: 3000 });
  assert.equal(ccConfig({ CC_SPARQL: 'http://x:7878/', CC_SITE: 'https://play.example' })?.site, 'https://play.example/');
  assert.equal(ccConfig({ CC_SPARQL: 'Off' }), null);
});

test('ccParts accepts only Concept Clusters IRIs that are safe to put in a query', () => {
  assert.deepEqual(ccParts(CLUSTER), { puzzle: 'moral-inversion', item: 'inverting-moral-value' });
  assert.deepEqual(ccParts(`${P}#term/cruelty-as-strength`), { puzzle: 'moral-inversion', item: 'term/cruelty-as-strength' });
  assert.deepEqual(ccParts(P), { puzzle: 'moral-inversion', item: null });
  for (const bad of ['https://example.org/x', `${P}> } DROP ALL { <y`, `${P}#a#b`, `${P}#x>`, 'urn:concept-clusters:puzzle:'])
    assert.equal(ccParts(bad), null, bad);
  assert.match(lookupQuery('moral-inversion', 'inverting-moral-value'), /GRAPH <urn:concept-clusters:graph:puzzle:moral-inversion>/);
});

test('a lookup names the item, its fact and terms, and the puzzle with its public URL; it caches, and says when an item is gone', async () => {
  const calls: string[] = [];
  const lookup = ccLookup(config, answering(clusterRows, calls));
  assert.deepEqual(await lookup(CLUSTER), { uri: CLUSTER, found: true, kind: 'cluster', label: 'Inverting moral value',
    text: 'Cruelty is treated as admirable.', terms: ['cruelty as strength', 'empathy as weakness'],
    puzzle: { id: 'moral-inversion', uri: P, title: 'Moral inversion', url: 'https://cc.example/?puzzle=moral-inversion' } });
  await lookup(CLUSTER);
  assert.equal(calls.length, 1);
  assert.equal(await lookup('https://en-word.net/id/oewn-1-n'), null);
  // The puzzle is published but the item isn't (a title row with no type), or the puzzle isn't at all (no rows).
  assert.deepEqual(await ccLookup(config, answering([{ title: v('Moral inversion') }]))(`${P}#gone`), { uri: `${P}#gone`, found: false });
  assert.deepEqual(await ccLookup(config, answering([]))(P), { uri: P, found: false });
  // A term names its cluster; a bridge, the clusters it connects and its kind.
  const bridge = await ccLookup(config, answering([['a', 'Reframing'], ['b', 'Inverting']].map(([end, endName]) => ({ title: v('Moral inversion'),
    type: v(VOCAB + 'Bridge'), name: v('normalization'), text: v('A fact.'), kind: v('dynamic'), end: v(`${P}#${end}`), endName: v(endName) }))))(`${P}#normalization`);
  assert.deepEqual([bridge?.kind, bridge?.relationKind, bridge?.connects?.map(end => end.label)], ['bridge', 'dynamic', ['Reframing', 'Inverting']]);
});

test('an answer is kept for a while, then asked for again, since puzzles are republished; a failure is never kept', async () => {
  const calls: string[] = [];
  const lookup = ccLookup(config, answering(clusterRows, calls), 10, 0);
  await lookup(CLUSTER); await lookup(CLUSTER);
  assert.equal(calls.length, 2);
  let failures = 0;
  const down = ccLookup(config, (async () => { failures++; throw new Error('down'); }) as typeof fetch);
  assert.equal(await down(CLUSTER), null);
  assert.equal(await down(CLUSTER), null);
  assert.equal(failures, 2);
  assert.equal(await ccLookup(null, answering(clusterRows))(CLUSTER), null);
});

test('search stems words so a framework label finds the puzzle wording, matches at word starts, and ranks the best first', async () => {
  assert.deepEqual(searchStems('Inversion of Moral Orientation'), ['inver', 'moral', 'orien']);
  assert.deepEqual(searchStems('Celebration or Mockery of Human Death'), ['celeb', 'mock', 'human', 'death']);
  assert.deepEqual(searchStems('war'), ['war']);
  assert.deepEqual(searchStems('a an of'), []);
  assert.match(searchQuery(['war']), /REGEX\(\?n, "\(\^\|\[\^a-z0-9\]\)war"\)/);
  assert.throws(() => searchQuery(['x" } DROP ALL { "']));
  const row = (x: string, type: string, name: string, text?: string) => ({ x: v(`${P}#${x}`), type: v(VOCAB + type), name: v(name),
    p: v(P), title: v('Moral inversion'), ...(text ? { text: v(text) } : {}) });
  const calls: string[] = [];
  const search = ccSearch(config, answering([
    row('normalization', 'Bridge', 'normalization', 'A culture begins to praise what it once excused: moral inversion.'),
    row('term/moral-orientation', 'Term', 'moral orientation'),
    row('inverting-moral-value', 'Cluster', 'Inverting moral value', 'Moral inversion goes beyond excusing harm.'),
    row('inverting-moral-value', 'Cluster', 'Inverting moral value', 'Moral inversion goes beyond excusing harm.')], calls));
  const found = await search('Inversion of moral orientation');
  assert.deepEqual(found?.map(item => item.label), ['Inverting moral value', 'moral orientation', 'normalization']);
  assert.equal(found?.[0].puzzle?.url, 'https://cc.example/?puzzle=moral-inversion');
  await search('  inversion OF moral   orientation ');
  assert.equal(calls.length, 1);
  assert.deepEqual(await search('of'), []);
  assert.equal(await ccSearch(null)('moral'), null);
  assert.equal(await ccSearch(config, (async () => { throw new Error('down'); }) as typeof fetch)('moral'), null);
});

test('the REST endpoints and MCP tools name Concept Clusters links, search puzzles, and find the terms linked to a puzzle', async t => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { createMcpServer } = await import('../src/mcp.js');
  const store = new Store(':memory:');
  store.addScheme({ id: 'df', label: 'Frameworks', hierarchy: 'graph' });
  const df6 = store.addTerm({ scheme: 'df', label: 'Inversion of Moral Orientation', status: 'active', links: [{ uri: CLUSTER, match: 'closeMatch' }] });
  store.addTerm({ scheme: 'df', label: 'Puzzle itself', status: 'active', links: [{ uri: P, match: 'relatedMatch' }] });
  store.addTerm({ scheme: 'df', label: 'Lookalike', status: 'active', links: [{ uri: `${P}-two`, match: 'relatedMatch' }] });
  const lookup = ccLookup(config, answering(clusterRows));
  const search = ccSearch(config, answering([{ x: v(CLUSTER), type: v(VOCAB + 'Cluster'), name: v('Inverting moral value'), p: v(P), title: v('Moral inversion') }]));
  const server = createApp(store, { conceptClusters: lookup, conceptClustersSearch: search });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await (await fetch(`${origin}/api/concept-clusters?uri=${encodeURIComponent(CLUSTER)}`)).json()).item.label, 'Inverting moral value');
  assert.equal((await (await fetch(`${origin}/api/concept-clusters/search?q=moral`)).json()).results[0].uri, CLUSTER);

  const connect = async (options: Parameters<typeof createMcpServer>[1]) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(store, options).connect(a), client.connect(b)]);
    t.after(() => client.close());
    return client;
  };
  const client = await connect({ conceptClusters: lookup, conceptClustersSearch: search });
  const term = (await client.callTool({ name: 'get_term', arguments: { ref: df6.id } })).structuredContent as { term: { links: Record<string, any>[] } };
  assert.equal(term.term.links[0].conceptClusters.puzzle.url, 'https://cc.example/?puzzle=moral-inversion');
  assert.equal(term.term.links[0].conceptClusters.uri, undefined);
  const found = (await client.callTool({ name: 'search_concept_clusters', arguments: { text: 'moral' } })).structuredContent as { results: { uri: string }[] };
  assert.deepEqual(found.results.map(item => item.uri), [CLUSTER]);
  // linksTo: the puzzle IRI finds links to it and to its items, but not to another puzzle whose id merely starts the same way.
  const linked = (await client.callTool({ name: 'search_terms', arguments: { linksTo: P } })).structuredContent as { items: { label: string }[] };
  assert.deepEqual(linked.items.map(item => item.label).sort(), ['Inversion of Moral Orientation', 'Puzzle itself']);
  const exact = (await client.callTool({ name: 'search_terms', arguments: { linksTo: CLUSTER } })).structuredContent as { items: { label: string }[] };
  assert.deepEqual(exact.items.map(item => item.label), ['Inversion of Moral Orientation']);
  const off = await (await connect({})).callTool({ name: 'search_concept_clusters', arguments: { text: 'moral' } });
  assert.equal(off.isError, true);
  assert.match((off.content as { text: string }[])[0].text, /unavailable/);
});
