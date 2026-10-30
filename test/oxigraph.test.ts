import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, cleanupStatement, iri, literal, ownedGraph, OxigraphError } from '../experiments/oxigraph/client.js';

const namespace = 'urn:terminology-mcp:feasibility:12345678-1234-1234-1234-123456789abc:';

test('cleanup refuses unrelated graphs and SPARQL injection in graph names', () => {
  for (const graph of ['http://example.org/production', 'urn:other:current', namespace,
    `${namespace}current> ; DROP ALL ; #`, `${namespace}current/../../other`]) {
    assert.throws(() => cleanupStatement(namespace, [graph]), /Refusing/);
  }
  assert.throws(() => cleanupStatement('urn:other:', ['urn:other:current']), /Refusing/);
  assert.throws(() => cleanupStatement(namespace, []), /No owned graphs/);
  assert.equal(ownedGraph(namespace, `${namespace}features:current`), `<${namespace}features:current>`);
  assert.equal(cleanupStatement(namespace, [`${namespace}features:current`, `${namespace}features:current`]).split('\n').length, 1);
  assert.throws(() => iri('http://example.org/> DROP ALL'), /Invalid/);
  const value = 'A "quote", a \\ and a newline\n社会';
  assert.equal(JSON.parse(literal(value)), value);
});

test('HTTP client sends query/update types, preserves failures, and refuses redirects and embedded credentials', async t => {
  const calls: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    if (url.endsWith('/update')) return new Response('intentional failure', { status: 409 });
    return new Response(JSON.stringify({ boolean: true }), { headers: { Server: 'Oxigraph/test' } });
  });
  const client = new Client('http://localhost:7878/');
  assert.equal(await client.ask('ask', 'ASK {}'), true);
  await assert.rejects(client.update('failure', 'CREATE GRAPH <urn:test>'), error =>
    error instanceof OxigraphError && error.status === 409);
  assert.equal(client.server, 'Oxigraph/test');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal((calls[0].options.headers as Record<string, string>)['Content-Type'], 'application/sparql-query');
  assert.equal((calls[1].options.headers as Record<string, string>)['Content-Type'], 'application/sparql-update');
  assert.equal(client.trace[1].status, 409);
  assert.match(client.trace[1].error!, /intentional failure/);
  await assert.rejects(client.loadTurtle('unsafe', namespace, 'urn:production', ''), /Refusing/);
  assert.equal(calls.length, 2);
  assert.throws(() => new Client('https://user:password@example.org'), /credentials/);
  assert.throws(() => new Client('file:///tmp/store'), /HTTP/);
});
