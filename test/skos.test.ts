import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { planSkos, exportSkos, rdfSchemes, parseRdf, SKOS } from '../src/skos.js';
import { importQuery, schemeQuery } from '../src/sparql.js';
import { readFileSync } from 'node:fs';

const turtle = readFileSync(new URL('./fixtures/research.ttl', import.meta.url), 'utf8');
const request = { format: 'turtle' as const, sourceScheme: 'https://example.org/scheme', schemeId: 'research', hierarchy: 'tree' as const, language: 'en' };

test('SKOS import previews without writes, preserves IRIs and five mapping types, and round-trips export', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(rdfSchemes(turtle)[0].uri, request.sourceScheme);
  const { plan, warnings } = planSkos(store, turtle, request);
  assert.ok(warnings.some(warning => warning.includes('languages')));
  const preview = store.preview(() => store.importScheme(plan, 0));
  assert.equal(preview.count, 3); assert.equal(store.version, 0); assert.equal(store.schemes().length, 0);
  const imported = store.importScheme(plan, 0);
  const root = store.lookup('https://example.org/root');
  const child = store.lookup('https://example.org/child');
  assert.deepEqual(child.broader, [root.id]);
  assert.equal(child.links.length, 5);
  const output = await exportSkos(store, 'research');
  const rdf = parseRdf(output);
  for (const match of ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'])
    assert.equal(rdf.countQuads('https://example.org/child', SKOS + match, null, null), 1);
  const copy = new Store(':memory:'); t.after(() => copy.close());
  const roundtrip = planSkos(copy, output, { ...request, schemeId: 'copy' });
  copy.importScheme(roundtrip.plan, 0);
  assert.equal(copy.lookup(child.sourceUri!).sourceUri, child.sourceUri);
  assert.deepEqual(copy.lookup(child.sourceUri!).links, child.links);
  assert.equal(copy.lookup(child.sourceUri!).scopeNote, child.scopeNote);
  const before = store.version;
  assert.throws(() => store.importScheme({ ...plan, scheme: { ...plan.scheme, id: 'duplicate' } }, before), /already imported/);
  assert.equal(store.version, before); assert.equal(store.schemes().length, 1);
  assert.throws(() => store.importScheme({ ...plan, scheme: { ...plan.scheme, id: 'stale' } }, 0), /workspace changed/);
  assert.equal(imported.count, 3);
});
test('imports reject cycles and external parents, and roll back a whole invalid scheme', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const { plan } = planSkos(store, turtle, request);
  const invalid = structuredClone(plan);
  invalid.terms.find(term => term.key.endsWith('/root'))!.broader = ['https://example.org/child'];
  assert.throws(() => store.importScheme(invalid, 0), /cycle/);
  assert.equal(store.version, 0); assert.equal(store.schemes().length, 0);
  assert.throws(() => planSkos(store, turtle + '\nx:root skos:broader x:outside .', request), /outside/);
  assert.throws(() => planSkos(store, turtle, { ...request, language: 'de' }), /preferred label/);
  assert.throws(() => parseRdf('not Turtle'), /Invalid Turtle/);
});
test('historical SKOS exports preserve the hierarchy before a move and include retirement metadata', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const { plan } = planSkos(store, turtle, request); store.importScheme(plan, 0);
  const child = store.lookup('https://example.org/child');
  const n = store.version;
  store.operate(child.id, { kind: 'move', broader: [], expectedVersion: n });
  const historical = parseRdf(await exportSkos(store, 'research', n));
  assert.equal(historical.countQuads(child.sourceUri!, SKOS + 'broader', null, null), 1);
  store.operate(child.id, { kind: 'retire', replacements: [], expectedVersion: store.version });
  const output = await exportSkos(store, 'research');
  assert.match(output, /retired/);
});
test('SPARQL source queries reject injected IRIs and never contain update commands', () => {
  assert.throws(() => importQuery('https://example.org/> } DROP ALL #'));
  assert.throws(() => schemeQuery('urn:test> } DROP ALL #'));
  const query = importQuery('https://example.org/scheme', 'urn:test:graph');
  assert.match(query, /CONSTRUCT/); assert.match(query, /GRAPH <urn:test:graph>/);
  assert.doesNotMatch(query, /INSERT|DELETE|LOAD|CLEAR|DROP/);
});

test('inverse SKOS mappings are normalized and unrepresented child edges are rejected', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const data = turtle + '\nx:external skos:broadMatch x:child .\nx:equivalent skos:exactMatch x:child .';
  const { plan } = planSkos(store, data, request);
  const child = plan.terms.find(term => term.key.endsWith('/child'))!;
  assert.ok(child.links.some(link => link.match === 'narrowMatch' && link.uri === 'https://example.org/external'));
  assert.ok(child.links.some(link => link.match === 'exactMatch' && link.uri === 'https://example.org/equivalent'));
  assert.throws(() => planSkos(store, turtle + '\nx:root skos:narrower x:missing .', request), /no membership/);
});
