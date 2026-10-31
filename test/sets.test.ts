import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { exportSkos, importRequestSchema, planSkos, parseRdf, SKOS } from '../src/skos.js';
import { type ConceptSet } from '../src/model.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  const a = store.addTerm({ scheme: 'subjects', label: 'Alpha', status: 'active' });
  const b = store.addTerm({ scheme: 'subjects', label: 'Beta', status: 'active' });
  const save = (members: string[], extra = {}) => store.saveSet({ scheme: 'subjects', slug: 'selected', label: 'Selected', members, ...extra }, store.version);
  return { store, a, b, save };
}
const fields = ({ id: _id, created: _created, changed: _changed, deleted: _deleted, ...fields }: ConceptSet) => fields;

test('set creation, editing, ordering, nested expansion, deletion and historical reads', t => {
  const { store, a, b, save } = fixture(t);
  const set = save([b.id, a.id], { ordered: true });
  assert.deepEqual(store.expandSet(set.id).terms.map(t => t.id), [b.id, a.id]);
  const parent = save([set.id, a.id], { slug: 'parent' });
  assert.deepEqual(store.expandSet(parent.id).terms.map(t => t.id), [a.id, b.id]);
  const updated = store.saveSet({ ...fields(set), members: [a.id] }, store.version, set.id);
  assert.deepEqual(store.conceptSet(set.id, set.created), set);
  assert.deepEqual(store.expandSet(parent.id, parent.created).terms.map(t => t.id), [a.id, b.id]);
  assert.deepEqual(store.expandSet(parent.id).terms.map(t => t.id), [a.id]);
  assert.throws(() => store.deleteSet(set.id, store.version), /parent collections/);
  store.deleteSet(parent.id, store.version); store.deleteSet(set.id, store.version);
  assert.equal(store.sets().length, 0); assert.deepEqual(store.conceptSet(set.id, updated.changed), updated);
  assert.throws(() => store.conceptSet(set.id), /not found/);
});

test('set validation is atomic: missing/cross-scheme members, duplicate slugs, source IRIs, duplicates and cycles', t => {
  const { store, a, save } = fixture(t);
  store.addScheme({ id: 'other', label: 'Other', hierarchy: 'poly' });
  const other = store.addTerm({ scheme: 'other', label: 'Other' });
  for (const members of [['missing'], [other.id], [a.id, a.id]]) {
    const version = store.version; assert.throws(() => save(members)); assert.equal(store.version, version);
  }
  const set = save([a.id]);
  assert.throws(() => save([]), /slugs/);
  const parent = save([set.id], { slug: 'parent' });
  const version = store.version;
  assert.throws(() => store.saveSet({ ...fields(set), members: [parent.id] }, version, set.id), /cycles/);
  assert.equal(store.version, version);
  assert.throws(() => store.saveSet({ ...fields(set), sourceUri: 'urn:changed' }, version, set.id), /cannot be changed/);
  assert.throws(() => store.saveSet(fields(set), version - 1, set.id), /workspace changed/);
});

test('merge preview and apply update direct and nested set membership at the same revision', t => {
  const { store, a, b, save } = fixture(t);
  const set = save([a.id, b.id], { ordered: true });
  const parent = save([set.id], { slug: 'parent' });
  const version = store.version, input = { kind: 'merge', target: b.id, expectedVersion: version };
  const preview = store.preview(() => store.operate(a.id, input));
  assert.equal(preview.affectedSets.length, 2); assert.equal(store.version, version);
  assert.deepEqual(store.conceptSet(set.id).members, [a.id, b.id]);
  const result = store.operate(a.id, input);
  assert.equal(store.conceptSet(set.id).changed, result.version);
  assert.deepEqual(store.expandSet(parent.id).terms.map(t => t.id), [b.id]);
  assert.deepEqual(store.expandSet(parent.id, version).terms.map(t => t.id), [a.id, b.id]);
  const change = store.changes(version)[0]; assert.equal(change.afterSets?.length, 1);
  assert.equal(change.afterSets?.[0].changed, change.n);
});

test('retirement and split preserve curated membership and warn without adding replacements', t => {
  for (const kind of ['retire', 'split']) {
    const { store, a, b, save } = fixture(t);
    const set = save([a.id]);
    const input = kind === 'retire' ? { kind, replacements: [b.id], expectedVersion: store.version }
      : { kind, newTerms: [{ label: 'Split one' }, { label: 'Split two' }], children: [], expectedVersion: store.version };
    const result = store.operate(a.id, input);
    assert.equal(result.affectedSets.length, 1);
    assert.deepEqual(store.conceptSet(set.id).members, [a.id]);
    assert.equal(store.expandSet(set.id).warnings.length, 1);
    assert.equal(store.expandSet(set.id).terms[0].status, 'retired');
  }
});

const source = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <https://example.org/> .
ex:scheme a skos:ConceptScheme; skos:prefLabel "Example" .
ex:a a skos:Concept; skos:inScheme ex:scheme; skos:prefLabel "Alpha" .
ex:b a skos:Concept; skos:inScheme ex:scheme; skos:prefLabel "Beta" .
ex:ordered a skos:OrderedCollection; skos:prefLabel "Reading order"; skos:memberList (ex:b ex:a) .
ex:nested a skos:Collection; skos:prefLabel "Nested"; skos:member ex:ordered, ex:a .`;
const request = (schemeId = 'imported') => importRequestSchema.parse({ format: 'turtle', sourceScheme: 'https://example.org/scheme', schemeId, hierarchy: 'tree' });

test('SKOS collections round-trip nested membership, ordered lists, metadata, source identities and empty sets', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const preview = planSkos(store, source, request());
  assert.equal(preview.plan.sets.length, 2); assert.deepEqual(preview.warnings, []);
  const result = store.importScheme(preview.plan, 0);
  const ordered = result.sets.find(s => s.label === 'Reading order')!;
  assert.deepEqual(store.expandSet(ordered.id).terms.map(t => t.label), ['Beta', 'Alpha']);
  store.saveSet({ scheme: 'imported', slug: 'empty', label: 'Empty', ordered: true, owner: 'editor', kind: 'profile' }, store.version);
  const ttl = await exportSkos(store, 'imported');
  assert.ok(parseRdf(ttl).countQuads(null, SKOS + 'memberList', null, null) >= 2);
  const other = new Store(':memory:'); t.after(() => other.close());
  const roundtrip = planSkos(other, ttl, request('copy'));
  other.importScheme(roundtrip.plan, 0);
  assert.equal(other.sets().length, 3);
  assert.equal(other.sets().find(s => s.label === 'Empty')?.kind, 'profile');
  assert.deepEqual(other.expandSet(other.sets().find(s => s.label === 'Reading order')!.id).terms.map(t => t.label), ['Beta', 'Alpha']);
});

test('malformed lists, literal/external members, duplicate identities and collection cycles are rejected atomically', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const variants = [
    source.replace('(ex:b ex:a)', '(ex:b ex:b)'),
    source.replace('(ex:b ex:a)', '(ex:b "literal")'),
    source.replace('(ex:b ex:a)', '(ex:b ex:unknown)'),
    source.replace('(ex:b ex:a)', '_:loop') + '\n_:loop <http://www.w3.org/1999/02/22-rdf-syntax-ns#first> ex:a; <http://www.w3.org/1999/02/22-rdf-syntax-ns#rest> _:loop .',
    source + '\nex:ordered skos:memberList (ex:a) .',
    source + '\nex:ordered skos:member ex:unknown .',
    source + '\nex:ordered skos:member ex:nested .',
    source.replace('ex:ordered a skos:OrderedCollection', 'ex:ordered a skos:Concept, skos:OrderedCollection'),
  ];
  for (const data of variants) {
    assert.throws(() => store.preview(() => store.importScheme(planSkos(store, data, request()).plan, 0)));
    assert.equal(store.version, 0); assert.equal(store.sets().length, 0); assert.equal(store.schemes().length, 0);
  }
});

test('v1 databases migrate without changing terms or history; sets persist after reopening', t => {
  const directory = mkdtempSync(join(tmpdir(), 'terminology-sets-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'store.sqlite');
  let store = new Store(filename);
  store.addScheme({ id: 'test', label: 'Test', hierarchy: 'tree' });
  const term = store.addTerm({ scheme: 'test', label: 'Existing' }); const version = store.version;
  store.close();
  const db = new Database(filename); db.exec('DROP TABLE set_revisions; DROP TABLE concept_sets; PRAGMA user_version = 1;'); db.close();
  store = new Store(filename);
  assert.equal(store.version, version); assert.equal(store.lookup(term.id).label, 'Existing');
  const set = store.saveSet({ scheme: 'test', slug: 'persisted', label: 'Persisted', members: [term.id] }, store.version);
  store.close(); store = new Store(filename); t.after(() => store.close());
  assert.deepEqual(store.expandSet(set.id).terms.map(t => t.id), [term.id]);
});

test('set API preview is read-only, rejects stale writes, supports historical expansion and serves editor assets', async t => {
  const { store, a } = fixture(t);
  const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown, method = 'POST') => fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const version = store.version;
  const body = { set: { scheme: 'subjects', slug: 'api', label: 'API set', members: [a.id] }, expectedVersion: version };
  const preview = await post('sets/preview', body); assert.equal(preview.status, 200);
  assert.equal((await preview.json()).terms.length, 1); assert.equal(store.version, version); assert.equal(store.sets().length, 0);
  const response = await post('sets', body); assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal((await post('sets/' + saved.set.id, body, 'PATCH')).status, 409);
  const history = await fetch(`${base}/api/sets/${saved.set.id}/expand?at=${saved.version}`); assert.equal(history.status, 200);
  assert.equal((await history.json()).terms[0].label, 'Alpha');
  for (const path of ['/sets', '/sets.js']) assert.equal((await fetch(base + path)).status, 200);
});

test('recipes expand concepts, descendants and symmetric typed neighbourhoods, then apply exclusions at a version', t => {
  const { store, a, b, save } = fixture(t);
  const child = store.addTerm({ scheme: 'subjects', label: 'Child', broader: [a.id], relations: [{ type: 'related', target: b.id }] });
  const grandchild = store.addTerm({ scheme: 'subjects', label: 'Grandchild', broader: [child.id] });
  const opposite = store.addTerm({ scheme: 'subjects', label: 'Opposite', relations: [{ type: 'opposite', target: b.id }] });
  const set = save([], { recipe: { concepts: [a.id], narrower: [a.id], around: [{ term: b.id, depth: 1, types: ['opposite'] }], exclude: [child.id] } });
  const version = store.version;
  assert.deepEqual(new Set(store.expandSet(set.id).terms.map(t => t.id)), new Set([a.id, b.id, grandchild.id, opposite.id]));
  store.operate(grandchild.id, { kind: 'move', broader: [], expectedVersion: store.version });
  assert.ok(!store.expandSet(set.id).terms.some(t => t.id === grandchild.id));
  assert.ok(store.expandSet(set.id, version).terms.some(t => t.id === grandchild.id));
  const nested = save([set.id], { slug: 'nested-recipe' });
  assert.equal(store.expandSet(nested.id).terms.length, store.expandSet(set.id).terms.length);
  const symmetric = save([], { slug: 'symmetric', recipe: { around: [{ term: b.id, depth: 1, types: ['related'] }] } });
  assert.ok(store.expandSet(symmetric.id).terms.some(t => t.id === child.id));
});

test('recipe validation, merge reference transfer, retirement warnings and impact on moves into a set', t => {
  const { store, a, b, save } = fixture(t);
  const recipe = save([], { recipe: { narrower: [a.id] } });
  const unrelated = save([a.id], { slug: 'unrelated' });
  assert.throws(() => save([a.id], { slug: 'invalid', recipe: {} }), /explicit members/);
  assert.throws(() => save([], { slug: 'invalid', ordered: true, recipe: {} }), /ordering/);
  assert.throws(() => save([], { slug: 'invalid', recipe: { concepts: [recipe.id] } }), /refer to terms/);
  assert.throws(() => save([], { slug: 'invalid', recipe: { around: [{ term: a.id, depth: 11, types: ['related'] }] } }));
  const moved = store.operate(b.id, { kind: 'move', broader: [a.id], expectedVersion: store.version });
  assert.ok(moved.affectedSets.some(s => s.id === recipe.id));
  assert.ok(!moved.affectedSets.some(s => s.id === unrelated.id));
  store.operate(b.id, { kind: 'move', broader: [], expectedVersion: store.version });
  store.operate(a.id, { kind: 'merge', target: b.id, expectedVersion: store.version });
  assert.deepEqual(store.conceptSet(recipe.id).recipe?.narrower, [b.id]);
  store.operate(b.id, { kind: 'retire', expectedVersion: store.version });
  assert.equal(store.expandSet(recipe.id).terms.length, 0);
  assert.ok(store.expandSet(recipe.id).warnings.some(w => w.includes('Retired recipe reference')));
});

test('SKOS recipe exports include expanded membership and preserve recipe IRIs through reimport', async t => {
  const { store, a, b, save } = fixture(t);
  store.operate(b.id, { kind: 'move', broader: [a.id], expectedVersion: store.version });
  save([], { recipe: { concepts: [a.id], narrower: [a.id], exclude: [b.id] } });
  const exported = await exportSkos(store, 'subjects');
  assert.equal(parseRdf(exported).countQuads(null, SKOS + 'member', null, null), 1);
  const copy = new Store(':memory:'); t.after(() => copy.close());
  const sourceScheme = 'urn:terminology-mcp:scheme:subjects';
  const plan = planSkos(copy, exported, importRequestSchema.parse({ format: 'turtle', sourceScheme, schemeId: 'copy', hierarchy: 'tree' })).plan;
  copy.importScheme(plan, 0);
  assert.equal(copy.sets()[0].recipe?.narrower.length, 1);
  assert.deepEqual(copy.expandSet(copy.sets()[0].id).terms.map(t => t.label), ['Alpha']);
});

test('a concept cannot reuse a collection source IRI or alias', t => {
  const { store, save } = fixture(t);
  save([], { sourceUri: 'https://example.org/collection' });
  const version = store.version;
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Conflict', sourceUri: 'https://example.org/collection' }), /collection IRI/);
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Conflict', aliases: ['https://example.org/collection'] }), /collection IRI/);
  assert.equal(store.version, version);
});

test('collection source IRIs remain reserved across deletion, scheme creation, concept creation and reimport', t => {
  const { store, a, save } = fixture(t);
  const uri = 'https://example.org/reserved-collection';
  const set = save([a.id], { sourceUri: uri });
  const rejectsReuse = () => {
    const version = store.version;
    assert.throws(() => store.addScheme({ id: 'collision', label: 'Collision', hierarchy: 'tree', sourceUri: uri }), /collection IRI/);
    assert.throws(() => save([], { slug: 'reused', sourceUri: uri }), /already in use/);
    assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Collision', sourceUri: uri }), /collection IRI/);
    assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Collision', aliases: [uri] }), /collection IRI/);
    assert.equal(store.version, version);
  };
  rejectsReuse();
  const updated = store.saveSet({ ...fields(set), description: 'The original owner may still edit its definition.' }, store.version, set.id);
  store.deleteSet(set.id, store.version);
  rejectsReuse();
  const version = store.version;
  const data = source.replaceAll('https://example.org/', 'https://example.org/reimport/').replace('ex:ordered a', `<${uri}> a`).replace('skos:member ex:ordered,', `skos:member <${uri}>,`);
  const plan = planSkos(store, data, importRequestSchema.parse({ format: 'turtle', sourceScheme: 'https://example.org/reimport/scheme', schemeId: 'reimport', hierarchy: 'tree' })).plan;
  assert.throws(() => store.importScheme(plan, version), /already in use/);
  assert.equal(store.version, version); assert.equal(store.schemes().length, 1);
  assert.equal(store.sets().length, 0);
  assert.deepEqual(store.conceptSet(set.id, updated.changed), updated);
});

test('an imported collection cannot take the IRI of an imported concept alias', t => {
  const { store } = fixture(t);
  const plan = planSkos(store, source, request()).plan;
  const uri = 'https://example.org/alias-collision';
  plan.terms[0].aliases = [...plan.terms[0].aliases, uri];
  plan.sets[0].key = uri;
  const version = store.version;
  assert.throws(() => store.importScheme(plan, version), /already in use/);
  assert.equal(store.version, version);
});
