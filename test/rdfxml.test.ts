import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { importRequestSchema, isRdfXml, owlAsSkos, parseRdf, planSkos, rdfSchemes, readRdf } from '../src/skos.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const request = (sourceScheme: string, schemeId: string, label?: string) =>
  importRequestSchema.parse({ format: 'turtle', sourceScheme, schemeId, hierarchy: 'auto', ...(label ? { label } : {}) });

test('isRdfXml tells RDF/XML from Turtle by how the file opens', () => {
  for (const xml of ['<?xml version="1.0"?><rdf:RDF/>', '﻿  <rdf:RDF xmlns:rdf="x">', '<!DOCTYPE rdf:RDF>', '<!-- c --><rdf:RDF>', '<RDF:RDF>'])
    assert.equal(isRdfXml(xml), true, xml);
  for (const turtle of ['@prefix x: <urn:x:> .', '<https://example.org/a> a <https://example.org/B> .', 'PREFIX x: <urn:x:>', '# comment\n<urn:a> <urn:b> <urn:c> .'])
    assert.equal(isRdfXml(turtle), false, turtle);
});

test('an RDF/XML file gives the same import plan as the same vocabulary in Turtle', async () => {
  const store = new Store(':memory:');
  const req = request('https://example.org/scheme', 'research');
  const fromXml = await readRdf(fixture('research.rdf'));
  assert.deepEqual(rdfSchemes(fromXml), rdfSchemes(fixture('research.ttl')));
  assert.deepEqual(planSkos(store, fromXml, req), planSkos(store, fixture('research.ttl'), req));
  store.close();
});

test('malformed or oversized RDF/XML is refused with a clear error', async () => {
  await assert.rejects(readRdf('<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>'),
    /Invalid RDF\/XML/);
  await assert.rejects(readRdf('<rdf:RDF>' + ' '.repeat(5 * 1024 * 1024)), /5 MiB/);
  assert.throws(() => parseRdf('<?xml version="1.0"?><rdf:RDF/>'), /readRdf/);
});

test('an OWL class hierarchy is read as a scheme, and what it leaves out is reported', async () => {
  const rdf = await readRdf(fixture('feelings.owl'));
  assert.deepEqual(rdfSchemes(rdf), [{ uri: 'https://example.org/feelings', labels: [{ value: 'Feelings', language: 'en' }] }]);
  const store = new Store(':memory:');
  const { plan, warnings, analysis } = planSkos(store, rdf, request('https://example.org/feelings', 'feelings'));
  assert.equal(plan.scheme.label, 'Feelings');
  assert.equal(analysis.selected, 'tree');
  const term = (label: string) => plan.terms.find(t => t.label === label)!;
  const feelingIri = 'https://example.org/feelings#Feeling', angerIri = 'https://example.org/feelings#Anger';
  assert.deepEqual(plan.terms.map(t => t.label).sort(), ['Rage', 'anger', 'feeling']);
  assert.equal(term('feeling').scopeNote, 'A conscious affective state.');
  assert.deepEqual(term('feeling').broader, []);
  assert.deepEqual(term('anger').broader, [feelingIri]);
  assert.equal(term('anger').scopeNote, 'A strong feeling of grievance.');
  assert.deepEqual(term('anger').altLabels.sort(), ['ire', 'wrath']);
  assert.deepEqual(term('anger').links, [{ uri: 'https://en-word.net/id/oewn-07531593-n', match: 'closeMatch' }]);
  assert.deepEqual(term('Rage').broader, [angerIri]);
  for (const expected of [/Read as an OWL class hierarchy: 3 classes/, /1 class restriction/, /1 superclass link to classes not declared/,
    /1 class has no label/, /owl#deprecated/, /1 other resource/, /other languages are omitted/])
    assert.ok(warnings.some(w => expected.test(w)), `${expected} in ${JSON.stringify(warnings)}`);
  assert.equal(store.importScheme(plan, 0).count, 3);
  store.close();
});

test('OWL without an ontology is named by the namespace its classes share, and SKOS files are left alone', async () => {
  const turtle = `@prefix owl: <http://www.w3.org/2002/07/owl#>. @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
    @prefix x: <https://example.org/ns/>. x:A a owl:Class; rdfs:label "A". x:B a owl:Class; rdfs:label "B"; rdfs:subClassOf x:A.`;
  const lifted = owlAsSkos(parseRdf(turtle))!;
  assert.deepEqual(rdfSchemes(turtle), [{ uri: 'https://example.org/ns/', labels: [{ value: 'ns', language: '' }] }]);
  assert.ok(lifted.warnings.some(w => /namespace, https:\/\/example\.org\/ns\//.test(w)));
  assert.ok(lifted.warnings.some(w => /called “ns” unless you give it a name/.test(w)));
  const store = new Store(':memory:');
  assert.equal(planSkos(store, turtle, request('https://example.org/ns/', 'ns', 'Named')).plan.scheme.label, 'Named');
  store.close();
  assert.equal(owlAsSkos(parseRdf(fixture('research.ttl'))), null);
  assert.throws(() => owlAsSkos(parseRdf(`@prefix owl: <http://www.w3.org/2002/07/owl#>.
    <https://a.example/A> a owl:Class. <https://b.example/B> a owl:Class.`)), /share no namespace/);
});

test('the import API finds and previews schemes in an RDF/XML upload', async t => {
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const data = fixture('feelings.owl');
  const found = await (await post('/api/imports/schemes', { format: 'turtle', data })).json();
  assert.equal(found.schemes[0].uri, 'https://example.org/feelings');
  const preview = await (await post('/api/imports/preview', { format: 'turtle', data, sourceScheme: 'https://example.org/feelings', schemeId: 'feelings' })).json();
  assert.equal(preview.count, 3);
  const bad = await post('/api/imports/schemes', { format: 'turtle', data: '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><oops' });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /Invalid RDF\/XML/);
});
