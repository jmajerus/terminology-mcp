import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { planSkos, exportSkos, parseRdf, SKOS } from '../src/skos.js';
import { notationSchema, XSD_STRING, RDF_LANG_STRING } from '../src/model.js';

const fixture = readFileSync(new URL('./fixtures/research.ttl', import.meta.url), 'utf8');
const request = { format: 'turtle' as const, sourceScheme: 'https://example.org/scheme', schemeId: 'notations', hierarchy: 'tree' as const, language: 'en' };

test('SKOS notations round-trip exact lexical forms, distinct datatypes, scheme codes, and all languages', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const data = fixture + '\nx:child skos:notation " code français "@fr, "003"^^<http://www.w3.org/2001/XMLSchema#integer> .';
  const { plan, warnings } = planSkos(store, data, request);
  assert.ok(!warnings.some(warning => warning.includes(SKOS + 'notation')));
  store.importScheme(plan, 0);
  const term = store.lookup('https://example.org/child');
  assert.equal(term.notations.length, 5);
  assert.ok(term.notations.some(value => value.value === '007' && value.datatype === XSD_STRING));
  assert.equal(term.notations.filter(value => value.value === '001.20').length, 2);
  assert.ok(term.notations.some(value => value.value === ' code français ' && value.language === 'fr' && value.datatype === RDF_LANG_STRING));
  const output = await exportSkos(store, request.schemeId);
  const before = parseRdf(data), after = parseRdf(output);
  for (const subject of ['https://example.org/scheme', 'https://example.org/child']) {
    const literals = (rdf: ReturnType<typeof parseRdf>) => rdf.getQuads(subject, SKOS + 'notation', null, null).map(q => q.object.id).sort();
    assert.deepEqual(literals(after), literals(before));
  }
  const copy = new Store(':memory:'); t.after(() => copy.close());
  copy.importScheme(planSkos(copy, output, { ...request, schemeId: 'copy' }).plan, 0);
  assert.deepEqual(copy.lookup(term.sourceUri!).notations, term.notations);
  assert.deepEqual(copy.schemes()[0].notations, store.schemes()[0].notations);
  assert.throws(() => planSkos(store, fixture + '\nx:child skos:notation x:notALiteral .', request), /must be RDF literals/);
});

test('notation edits persist in history, deduplicate identical literals, and old clients preserve codes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'codes', label: 'Codes', hierarchy: 'tree' });
  const term = store.addTerm({ scheme: 'codes', label: 'A', notations: [{ value: '001' }, { value: '001' }] });
  assert.deepEqual(term.notations, [{ value: '001', datatype: XSD_STRING }]);
  const changed = store.editTerm(term.id, { label: 'A', scopeNote: 'Unrelated note edit', expectedChanged: term.changed });
  assert.deepEqual(changed.notations, term.notations);
  const edited = store.editTerm(term.id, { label: 'A', notations: [{ value: '002', datatype: 'urn:code:custom' }], expectedChanged: changed.changed });
  assert.equal(edited.notations[0].value, '002');
  assert.equal(store.lookup(term.id, changed.changed).notations[0].value, '001');
  assert.equal(store.changes(changed.changed)[0].kind, 'updated');
  const cleared = store.editTerm(term.id, { label: 'A', notations: [], expectedChanged: edited.changed });
  assert.deepEqual(cleared.notations, []);
  assert.throws(() => notationSchema.parse({ value: 'a', language: 'en', datatype: 'urn:custom' }));
  assert.throws(() => notationSchema.parse({ value: 'a', datatype: RDF_LANG_STRING }));
});

test('merge retains both sets of notations; split keeps codes on the original retired concept', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'codes', label: 'Codes', hierarchy: 'tree' });
  const a = store.addTerm({ scheme: 'codes', label: 'A', notations: [{ value: 'A1' }] });
  const b = store.addTerm({ scheme: 'codes', label: 'B', notations: [{ value: 'B1' }] });
  store.operate(a.id, { kind: 'merge', target: b.id, expectedVersion: store.version });
  assert.deepEqual(store.lookup(b.id).notations.map(value => value.value), ['B1', 'A1']);
  const split = store.operate(b.id, { kind: 'split', expectedVersion: store.version, children: [], newTerms: [{ label: 'One' }, { label: 'Two' }] });
  assert.equal(split.term.notations.length, 2);
  for (const id of split.term.replacedBy) assert.deepEqual(store.lookup(id).notations, []);
});

test('legacy term and scheme bodies without notations remain readable and editable', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'old', label: 'Old', hierarchy: 'tree' });
  const term = store.addTerm({ scheme: 'old', label: 'Old term' });
  store.db.exec(`UPDATE terms SET body = json_remove(body, '$.notations');
    UPDATE term_revisions SET body = json_remove(body, '$.notations');
    UPDATE schemes SET body = json_remove(body, '$.notations');`);
  assert.deepEqual(store.schemes()[0].notations, []);
  assert.deepEqual(store.lookup(term.id).notations, []);
  store.editTerm(term.id, { label: term.label, scopeNote: 'Edited', expectedChanged: term.changed });
  assert.deepEqual(store.lookup(term.id).notations, []);
});
