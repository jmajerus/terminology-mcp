import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('search_terms with narrower lists what an index term maps as narrower, both ways, named or as IRIs', async t => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { createMcpServer } = await import('../src/mcp.js');
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'index', label: 'Index', hierarchy: 'graph' });
  store.addScheme({ id: 'df', label: 'Frameworks', hierarchy: 'graph' });
  const df6 = store.addTerm({ scheme: 'df', label: 'Inversion of Moral Orientation', status: 'active', sourceUri: 'urn:x:df6' });
  const retired = store.addTerm({ scheme: 'df', label: 'Old signal', status: 'active' });
  store.operate(retired.id, { kind: 'retire', replacements: [], expectedVersion: store.version });
  const hub = store.addTerm({ scheme: 'index', label: 'depravity', status: 'active', links: [
    { uri: 'urn:x:df6', match: 'narrowMatch' }, { uri: `urn:terminology-mcp:term:${retired.id}`, match: 'narrowMatch' },
    { uri: 'urn:concept-clusters:puzzle:p#c', match: 'narrowMatch' }, { uri: 'https://en-word.net/id/oewn-1-n', match: 'closeMatch' }] });
  // The reverse form: a specific term that names the index term as broader.
  const signal = store.addTerm({ scheme: 'df', label: 'Celebration or Mockery of Human Death', status: 'active',
    links: [{ uri: `urn:terminology-mcp:term:${hub.id}`, match: 'broadMatch' }] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([createMcpServer(store).connect(a), client.connect(b)]);
  t.after(() => client.close());
  type Hit = { label: string; narrowerMatches?: { iri: string; key?: string; label?: string; scheme?: string }[] };
  const search = async (args: object) => ((await client.callTool({ name: 'search_terms', arguments: args })).structuredContent as { items: Hit[] }).items;
  const [found] = await search({ query: 'depravity', narrower: true });
  // Sorted by label, external IRIs by IRI; the retired target and the closeMatch are left out.
  assert.deepEqual(found.narrowerMatches, [
    { iri: `urn:terminology-mcp:term:${signal.id}`, key: 'df:celebration-or-mockery-of-human-death', id: signal.id, label: 'Celebration or Mockery of Human Death', scheme: 'df' },
    { iri: 'urn:x:df6', key: 'df:inversion-of-moral-orientation', id: df6.id, label: 'Inversion of Moral Orientation', scheme: 'df' },
    { iri: 'urn:concept-clusters:puzzle:p#c' }]);
  assert.equal((await search({ query: 'depravity' }))[0].narrowerMatches, undefined);
  assert.deepEqual((await search({ query: 'inversion', narrower: true }))[0].narrowerMatches, []);
});
