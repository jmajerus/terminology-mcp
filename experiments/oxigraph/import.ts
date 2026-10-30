import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, cleanupStatement, iri } from './client.js';
import { Store } from '../../src/store.js';
import { createApp } from '../../src/server.js';
import { parseRdf, planSkos } from '../../src/skos.js';
import { fetchScheme } from '../../src/sparql.js';
import type { ImportPlan } from '../../src/model.js';

const runId = randomUUID();
const namespace = `urn:terminology-mcp:feasibility:${runId}:`;
const client = new Client(process.env.OXIGRAPH_URL ?? 'http://oxigraph.localdomain:7878');
const endpoint = `${client.endpoint}/query`;
const graphs = [`${namespace}import:source`, `${namespace}import:roundtrip`, `${namespace}import:standard-collections`];
const directory = resolve('data/oxigraph-import', runId);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ namespace, endpoint: client.endpoint, graphs }, null, 2));
writeFileSync(join(directory, 'cleanup.ru'), cleanupStatement(namespace, graphs));
const store = new Store(join(directory, 'import.sqlite'));
const server = createApp(store);
const results: { check: string; passed: boolean; detail?: unknown }[] = [];
let cleanup = 'not attempted';
let listening = false;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); listening = true;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, data: unknown) => {
    const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
  };
  const source = readFileSync(new URL('../../test/fixtures/research.ttl', import.meta.url), 'utf8') + `
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <https://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
ex:reading a skos:OrderedCollection; skos:prefLabel \"Reading order\"; skos:memberList ex:list1 .
ex:list1 rdf:first ex:child; rdf:rest ex:list2 .
ex:list2 rdf:first ex:root; rdf:rest rdf:nil .
ex:group skos:prefLabel \"Nested group\"; skos:member ex:reading .
ex:empty a skos:OrderedCollection; skos:prefLabel \"Empty\"; skos:memberList rdf:nil; <urn:terminology-mcp:vocab:scheme> ex:scheme .
`;
  const standardCollections = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix std: <https://example.org/standard/> .
std:scheme a skos:ConceptScheme; skos:prefLabel "Standard lists" .
std:a a skos:Concept; skos:inScheme std:scheme; skos:prefLabel "A" .
std:b a skos:Concept; skos:inScheme std:scheme; skos:prefLabel "B" .
std:typed a skos:OrderedCollection; skos:prefLabel "Typed list"; skos:memberList (std:b std:a) .
std:implicit skos:prefLabel "Implicit list"; skos:memberList (std:a std:b) .
std:parent a skos:Collection; skos:prefLabel "Parent"; skos:member std:typed, std:implicit .`;
  await client.loadTurtle('standard-collection-fixture', namespace, graphs[2], standardCollections);
  const standardPreview = await post('imports/preview', { format: 'sparql', endpoint, graph: graphs[2],
    sourceScheme: 'https://example.org/standard/scheme', schemeId: 'standard', hierarchy: 'tree', language: 'en' });
  assert.equal(standardPreview.plan.sets.length, 3);
  for (const [name, members] of [['typed', ['b', 'a']], ['implicit', ['a', 'b']]] as const) {
    const collection = standardPreview.plan.sets.find((set: { key: string }) => set.key === `https://example.org/standard/${name}`);
    assert.equal(collection.ordered, true);
    assert.deepEqual(collection.members, members.map(member => `https://example.org/standard/${member}`));
  }
  assert.equal(store.version, 0);
  results.push({ check: 'standard typed and implicit ordered collections import blank-node RDF lists without application markers', passed: true });
  await client.loadTurtle('fixture-source', namespace, graphs[0], source);
  const fingerprint = (data: string) => parseRdf(data).getQuads(null, null, null, null).map(q =>
    [q.subject.id, q.predicate.id, q.object.id].join(' ')).sort();
  const before = await client.turtle('source-before', `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${iri(graphs[0])} { ?s ?p ?o } }`);
  const discovered = await post('imports/schemes', { format: 'sparql', endpoint, graph: graphs[0] });
  assert.ok(discovered.schemes.some((scheme: { uri: string }) => scheme.uri === 'https://example.org/scheme'));
  results.push({ check: 'scheme discovery over SPARQL through the application API', passed: true });
  const preview = await post('imports/preview', { format: 'sparql', endpoint, graph: graphs[0],
    sourceScheme: 'https://example.org/scheme', schemeId: 'research', hierarchy: 'tree', language: 'en' });
  assert.equal(preview.count, 3); assert.equal(store.version, 0);
  const automatic = await post('imports/preview', { format: 'sparql', endpoint, graph: graphs[0],
    sourceScheme: 'https://example.org/scheme', schemeId: 'research', hierarchy: 'auto', language: 'en' });
  assert.equal(automatic.analysis.selected, 'graph');
  const edges = (plan: ImportPlan) => plan.terms.flatMap(term => [
    ...term.broader.map(parent => `${term.key}|broader|${parent}`),
    ...term.relations.map(relation => `${term.key}|${relation.type}|${relation.target}`),
  ]).sort();
  assert.deepEqual(edges(automatic.plan), edges(preview.plan));
  assert.equal(store.version, 0);
  results.push({ check: 'SPARQL Auto recommends a graph and preserves every hierarchical and associative edge', passed: true });
  results.push({ check: 'preview reads source without writing SQLite', passed: true, detail: { terms: 3, warnings: preview.warnings } });
  const imported = await post('imports/apply', { plan: preview.plan, expectedVersion: preview.expectedVersion });
  assert.equal(imported.count, 3);
  assert.equal(store.sets().length, 3);
  const reading = store.sets().find(set => set.sourceUri === 'https://example.org/reading')!;
  assert.deepEqual(store.expandSet(reading.id).terms.map(term => term.sourceUri), ['https://example.org/child', 'https://example.org/root']);
  results.push({ check: 'SPARQL imports nested, ordered and empty collections including RDF list cells', passed: true });
  const child = store.lookup('https://example.org/child');
  const root = store.lookup('https://example.org/root');
  assert.deepEqual(child.broader, [root.id]);
  assert.equal(child.links.length, 5);
  assert.equal(child.notations.length, 3);
  assert.equal(store.schemes()[0].notations[0].value, 'RES');
  results.push({ check: 'apply creates the scheme with stable local IDs, original IRIs, and all five mappings', passed: true });
  store.saveSet({ scheme: 'research', slug: 'recipe', label: 'Recipe selection', recipe: { concepts: [root.id], narrower: [root.id], exclude: [child.id] } }, store.version);
  const exported = await fetch(`${base}/api/schemes/research/skos`);
  assert.equal(exported.status, 200);
  const output = await exported.text(); writeFileSync(join(directory, 'export.ttl'), output);
  await client.loadTurtle('roundtrip-export', namespace, graphs[1], output);
  const fetched = await fetchScheme(endpoint, 'https://example.org/scheme', graphs[1]);
  const copy = new Store(':memory:');
  try {
    const planned = planSkos(copy, fetched, { format: 'sparql', endpoint, sourceScheme: 'https://example.org/scheme',
      schemeId: 'roundtrip', hierarchy: 'tree', language: 'en' });
  assert.equal(planned.plan.sets.length, 4);
  assert.deepEqual(planned.plan.sets.find(set => set.key === 'https://example.org/reading')?.members, ['https://example.org/child', 'https://example.org/root']);
    copy.importScheme(planned.plan, 0);
    const recipe = copy.sets().find(set => set.slug === 'recipe')!;
    assert.ok(recipe.recipe);
    assert.deepEqual(new Set(copy.expandSet(recipe.id).terms.map(term => term.sourceUri)), new Set(['https://example.org/root', 'https://example.org/peer']));
    results.push({ check: 'recipe definitions and expanded SKOS membership round-trip through Oxigraph', passed: true });
    const again = copy.lookup(child.sourceUri!);
    assert.equal(copy.terms().length, 3);
    assert.equal(again.label, child.label); assert.equal(again.scopeNote, child.scopeNote);
    assert.deepEqual(again.links, child.links);
    assert.deepEqual(again.notations.map(value => JSON.stringify(value)).sort(), child.notations.map(value => JSON.stringify(value)).sort());
    assert.deepEqual(copy.schemes()[0].notations, store.schemes()[0].notations);
    assert.equal(copy.lookup(again.broader[0]).sourceUri, root.sourceUri);
    results.push({ check: 'SQLite export → Oxigraph → SPARQL reimport preserves labels, hierarchy, source IRIs and mappings', passed: true });
  } finally { copy.close(); }
  const currentVersion = store.version;
  const duplicate = await fetch(`${base}/api/imports/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: { ...preview.plan, scheme: { ...preview.plan.scheme, id: 'duplicate' } }, expectedVersion: currentVersion }) });
  assert.equal(duplicate.status, 409); assert.equal(store.version, currentVersion); assert.equal(store.schemes().length, 1);
  results.push({ check: 'duplicate source identities are rejected without partial writes', passed: true });
  const after = await client.turtle('source-after', `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${iri(graphs[0])} { ?s ?p ?o } }`);
  assert.deepEqual(fingerprint(after), fingerprint(before));
  results.push({ check: 'importer leaves source graph unchanged', passed: true });
  // Alter only our disposable fixture to verify inbound membership assertions
  // survive CONSTRUCT and receive the same validation as a file import.
  await client.update('fixture-mixed-membership', `INSERT DATA { GRAPH ${iri(graphs[0])} {
    <https://example.org/other> <http://www.w3.org/2004/02/skos/core#hasTopConcept> <https://example.org/child> .
  } }`);
  const mixed = await fetch(`${base}/api/imports/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'sparql', endpoint, graph: graphs[0], sourceScheme: 'https://example.org/scheme',
      schemeId: 'mixed', hierarchy: 'tree', language: 'en' }) });
  assert.equal(mixed.status, 422);
  assert.match((await mixed.json()).error, /multiple schemes/);
  assert.equal(store.version, currentVersion);
  results.push({ check: 'SPARQL imports retain inbound hasTopConcept and reject mixed memberships', passed: true });
} catch (error) {
  results.push({ check: 'integration run', passed: false, detail: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
  try {
    await client.update('cleanup-import', cleanupStatement(namespace, graphs));
    const remaining = await client.select('verify-cleanup-import', `SELECT ?g WHERE { VALUES ?g { ${graphs.map(iri).join(' ')} } GRAPH ?g { } }`);
    assert.equal(remaining.results.bindings.length, 0); cleanup = 'removed and verified';
  } catch (error) { cleanup = String(error); process.exitCode = 1; }
  const report = { runId, endpoint, server: client.server, graphs, at: new Date().toISOString(), cleanup, results };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(directory, 'requests.jsonl'), client.trace.map(row => JSON.stringify(row)).join('\n') + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Artifacts: ${directory}`);
}
