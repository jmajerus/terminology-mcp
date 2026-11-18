import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { synsetId, synsetQuery, wordnetConfig, wordnetLookup, type WordnetConfig } from '../src/wordnet.js';

const ANGER = 'https://en-word.net/id/oewn-07531593-n';
const config: WordnetConfig = { baseUrl: 'http://wordnet.test', graph: 'urn:wordnet:graph:oewn-2025', timeoutMs: 1000 };
const row = (word: string) => ({ pos: { value: 'https://globalwordnet.github.io/schemas/wn#noun' },
  def: { value: 'a strong emotion' }, word: { value: word } });
const answering = (bindings: unknown[], calls: string[] = []) => (async (_url: unknown, init?: RequestInit) => {
  calls.push(String(new URLSearchParams(String(init?.body)).get('query')));
  return new Response(JSON.stringify({ results: { bindings } }), { status: 200 });
}) as typeof fetch;

test('wordnetConfig: unset means the LAN server, off turns lookups off', () => {
  assert.equal(wordnetConfig({})?.baseUrl, 'http://wordnet.localdomain:7878');
  assert.equal(wordnetConfig({ WORDNET_SPARQL: 'http://x:7878/' })?.baseUrl, 'http://x:7878');
  assert.equal(wordnetConfig({ WORDNET_SPARQL: 'OFF' }), null);
});

test('synsetId accepts only Open English WordNet ids that are safe to put in a query', () => {
  assert.equal(synsetId(ANGER), 'oewn-07531593-n');
  assert.equal(synsetId('http://purl.org/vocabularies/princeton/wn30/synset-anger-noun-1.rdf'), null);
  assert.equal(synsetId('https://en-word.net/id/x> } DROP ALL { <y'), null);
  assert.throws(() => synsetQuery('a>b', config.graph));
});

test('lookup folds rows into words, part of speech and definition, and caches per id', async () => {
  const calls: string[] = [];
  const lookup = wordnetLookup(config, answering([row('ire'), row('anger'), row('choler'), row('anger')], calls));
  const synset = await lookup(ANGER);
  assert.deepEqual(synset, { uri: ANGER, found: true, words: ['anger', 'choler', 'ire'], pos: 'noun', definition: 'a strong emotion' });
  await lookup(ANGER);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /BIND\(<https:\/\/en-word\.net\/id\/oewn-07531593-n> AS \?synset\)/);
  assert.equal(await lookup('https://example.org/x'), null);
  assert.deepEqual(await wordnetLookup(config, answering([]))(ANGER), { uri: ANGER, found: false });
});

test('an unreachable server gives null and is asked again next time', async () => {
  let calls = 0;
  const lookup = wordnetLookup(config, (async () => { calls++; throw new Error('down'); }) as typeof fetch);
  assert.equal(await lookup(ANGER), null);
  assert.equal(await lookup(ANGER), null);
  assert.equal(calls, 2);
  assert.equal(await wordnetLookup(null, answering([row('anger')]))(ANGER), null);
});

test('GET /api/wordnet describes a link, and answers null when lookups are off', async t => {
  const store = new Store(':memory:');
  const servers = [createApp(store, { wordnet: wordnetLookup(config, answering([row('anger')])) }), createApp(store)];
  const origins: string[] = [];
  for (const server of servers) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origins.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  t.after(async () => {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  });
  const on = await (await fetch(`${origins[0]}/api/wordnet?uri=${encodeURIComponent(ANGER)}`)).json();
  assert.deepEqual(on.synset.words, ['anger']);
  const off = await (await fetch(`${origins[1]}/api/wordnet?uri=${encodeURIComponent(ANGER)}`)).json();
  assert.equal(off.synset, null);
});

test('MCP get_term adds the synset gloss to a WordNet link and leaves other links alone', async t => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { createMcpServer } = await import('../src/mcp.js');
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  const term = store.addTerm({ scheme: 'subjects', label: 'Anger', links: [
    { uri: ANGER, match: 'closeMatch' }, { uri: 'https://example.org/anger', match: 'relatedMatch' }] });
  const read = async (wordnet?: ReturnType<typeof wordnetLookup>) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(store, { wordnet }).connect(a), client.connect(b)]);
    const result = await client.callTool({ name: 'get_term', arguments: { ref: term.id } });
    await client.close();
    return (result.structuredContent as { term: { links: Record<string, unknown>[] } }).term.links;
  };
  assert.deepEqual(await read(wordnetLookup(config, answering([row('anger')]))), [
    { uri: ANGER, match: 'closeMatch', wordnet: { found: true, words: ['anger'], pos: 'noun', definition: 'a strong emotion' } },
    { uri: 'https://example.org/anger', match: 'relatedMatch' }]);
  assert.deepEqual((await read(wordnetLookup(config, (async () => { throw new Error('down'); }) as typeof fetch)))[0],
    { uri: ANGER, match: 'closeMatch' });
  assert.deepEqual((await read())[0], { uri: ANGER, match: 'closeMatch' });
});
