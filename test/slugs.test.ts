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
import { planSkos, exportSkos } from '../src/skos.js';
import { slugify } from '../src/model.js';

function subjects(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree', slugUniqueDepths: [1, 0, 1] });
  const humanities = store.addTerm({ scheme: 'subjects', label: 'Humanities' });
  const science = store.addTerm({ scheme: 'subjects', label: 'Science' });
  return { store, humanities, science };
}

test('slugify follows Concept Clusters’ rule, folds diacritics, caps length and falls back', () => {
  assert.equal(slugify('Ritual & Practice'), 'ritual-practice');
  assert.equal(slugify('  Physical Geography!  '), 'physical-geography');
  assert.equal(slugify('Économie politique'), 'economie-politique');
  assert.equal(slugify('日本'), 'term');
  const long = slugify('word '.repeat(30));
  assert.ok(long.length <= 80 && !long.endsWith('-') && long.startsWith('word-word'));
  assert.equal(slugify('x'.repeat(100)).length, 80);
});

test('slugs are minted once, survive renames, and suffix within their scope', t => {
  const { store, humanities, science } = subjects(t);
  assert.equal(humanities.slug, 'humanities');
  const renamed = store.editTerm(humanities.id, { label: 'The Humanities', expectedChanged: humanities.changed });
  assert.equal(renamed.slug, 'humanities');
  const history = store.addTerm({ scheme: 'subjects', label: 'History', broader: [humanities.id] });
  const twin = store.addTerm({ scheme: 'subjects', label: 'Histöry', broader: [humanities.id] });
  assert.equal(history.slug, 'history');
  assert.equal(twin.slug, 'history-2');
  // Depth 1 is scheme-wide, so a category under another domain is suffixed too.
  assert.equal(store.addTerm({ scheme: 'subjects', label: 'History', broader: [science.id] }).slug, 'history-3');
  // Depth 2 is unique among siblings only.
  const a = store.addTerm({ scheme: 'subjects', label: 'Hydrology', broader: [history.id] });
  const b = store.addTerm({ scheme: 'subjects', label: 'Hydrology', broader: [twin.id] });
  assert.equal(a.slug, 'hydrology'); assert.equal(b.slug, 'hydrology');
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Other', slug: 'history', broader: [science.id] }), /already used at this depth/);
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Bad', slug: 'Bad--slug' }));
});

test('each listed depth is its own scope: a domain and its category may share a slug', t => {
  const { store, humanities } = subjects(t);
  const category = store.addTerm({ scheme: 'subjects', label: 'Humanities', slug: 'humanities', broader: [humanities.id] });
  assert.equal(category.slug, 'humanities');
  assert.equal(store.slugLookup('subjects', 'humanities', { parent: humanities.id }).term.id, category.id);
  assert.equal(store.slugLookup('subjects', 'humanities', { depth: 0 }).term.id, humanities.id);
  assert.throws(() => store.slugLookup('subjects', 'humanities'), /several terms/);
  const digital = store.addTerm({ scheme: 'subjects', label: 'Digital Humanities', broader: [category.id] });
  assert.equal(store.slugLookup('subjects', 'digital-humanities', { parent: 'humanities' }).term.id, digital.id);
  assert.equal(store.slugLookup('subjects', 'humanities', { parent: 'humanities' }).term.id, category.id);
  assert.throws(() => store.slugLookup('subjects', 'digital-humanities', { parent: 'nowhere' }), /No parent term/);
});

test('slug depths apply only to tree schemes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.throws(() => store.addScheme({ id: 'concepts', label: 'Concepts', hierarchy: 'poly', slugUniqueDepths: [0] }), /only to tree/);
});

test('changing a slug is a breaking operation that keeps the old slug reserved and resolvable', t => {
  const { store, humanities, science } = subjects(t);
  const n = store.version;
  const op = { kind: 'slug', slug: 'arts', expectedVersion: n, reason: 'CC rename' };
  const preview = store.preview(() => store.operate(humanities.id, op));
  assert.equal(preview.term.slug, 'arts'); assert.equal(store.version, n);
  assert.equal(store.lookup(humanities.id).slug, 'humanities');
  const result = store.operate(humanities.id, op);
  assert.deepEqual([result.term.slug, result.term.formerSlugs], ['arts', ['humanities']]);
  const [change] = store.changes(n);
  assert.equal(change.kind, 'slugged'); assert.equal(change.breaking, true);
  assert.deepEqual(store.slugLookup('subjects', 'humanities'), { version: result.version, term: store.lookup(humanities.id), current: false });
  assert.equal(store.slugLookup('subjects', 'humanities', {}, n).current, true);
  assert.throws(() => store.operate(science.id, { kind: 'slug', slug: 'humanities', expectedVersion: store.version }), /already used/);
  assert.throws(() => store.operate(humanities.id, { kind: 'slug', slug: 'arts', expectedVersion: store.version }), /already this term/);
  const back = store.operate(humanities.id, { kind: 'slug', slug: 'humanities', expectedVersion: store.version });
  assert.deepEqual([back.term.slug, back.term.formerSlugs], ['humanities', ['arts']]);
});

test('moves that would collide are refused; splits mint slugs for new terms', t => {
  const { store, humanities, science } = subjects(t);
  store.addTerm({ scheme: 'subjects', label: 'Ethics', broader: [humanities.id] });
  const ethics = store.addTerm({ scheme: 'subjects', label: 'Ethics', broader: [science.id] });
  assert.equal(ethics.slug, 'ethics-2');
  const topLevel = store.addTerm({ scheme: 'subjects', label: 'Law' });
  store.addTerm({ scheme: 'subjects', label: 'Law', slug: 'law', broader: [science.id] });
  assert.throws(() => store.operate(topLevel.id, { kind: 'move', broader: [humanities.id], expectedVersion: store.version }), /already used at this depth/);
  const split = store.operate(ethics.id, { kind: 'split', expectedVersion: store.version,
    newTerms: [{ label: 'Bioethics' }, { label: 'Éthics' }], children: [] });
  const created = split.affected.filter(row => !row.before).map(row => row.after.slug).sort();
  assert.deepEqual(created, ['bioethics', 'ethics-3']);
});

test('SKOS carries slugs, former slugs and slug depths through import and export', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const turtle = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix t: <urn:terminology-mcp:vocab:> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    <urn:s> a skos:ConceptScheme ; skos:prefLabel "Subjects" ; t:hierarchy "tree" ; t:slugUniqueDepth "0"^^xsd:integer, "1"^^xsd:integer .
    <urn:h> a skos:Concept ; skos:inScheme <urn:s> ; skos:prefLabel "Humanities" ; t:slug "humanities" .
    <urn:hc> a skos:Concept ; skos:inScheme <urn:s> ; skos:prefLabel "General Humanities" ; skos:broader <urn:h> ; t:slug "humanities" .
    <urn:g> a skos:Concept ; skos:inScheme <urn:s> ; skos:prefLabel "Physical Geography" ; skos:broader <urn:h> ; t:slug "geography" ; t:formerSlug "physical-geography" .
    <urn:n> a skos:Concept ; skos:inScheme <urn:s> ; skos:prefLabel "No Slug" ; skos:broader <urn:g> .`;
  const request = { format: 'turtle' as const, sourceScheme: 'urn:s', schemeId: 'subjects', hierarchy: 'auto' as const, language: 'en' };
  const { plan, warnings } = planSkos(store, turtle, request);
  assert.deepEqual(warnings, []);
  store.importScheme(plan, 0);
  assert.deepEqual(store.schemes()[0].slugUniqueDepths, [0, 1]);
  assert.equal(store.lookup('urn:hc').slug, 'humanities');
  assert.deepEqual([store.lookup('urn:g').slug, store.lookup('urn:g').formerSlugs], ['geography', ['physical-geography']]);
  assert.equal(store.lookup('urn:n').slug, 'no-slug');
  const copy = new Store(':memory:'); t.after(() => copy.close());
  copy.importScheme(planSkos(copy, await exportSkos(store, 'subjects'), request).plan, 0);
  for (const uri of ['urn:h', 'urn:hc', 'urn:g', 'urn:n'])
    assert.deepEqual([copy.lookup(uri).slug, copy.lookup(uri).formerSlugs], [store.lookup(uri).slug, store.lookup(uri).formerSlugs]);
  assert.deepEqual(copy.schemes()[0].slugUniqueDepths, [0, 1]);
  const clash = turtle.replace('t:slug "geography"', 't:slug "humanities"');
  assert.throws(() => store.preview(() => copy.importScheme(planSkos(new Store(':memory:'), clash, request).plan, copy.version)), /already/);
});

test('older stores get slugs and a log id on open, including history and change snapshots', t => {
  const directory = mkdtempSync(join(tmpdir(), 'terminology-slugs-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'old.sqlite');
  const store = new Store(filename);
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  const root = store.addTerm({ scheme: 'subjects', label: 'Root' });
  store.addTerm({ scheme: 'subjects', label: 'Röot' });
  store.close();
  const db = new Database(filename);
  const strip = (body: string) => { const value = JSON.parse(body); delete value.slug; delete value.formerSlugs; delete value.after?.slug; return JSON.stringify(value); };
  for (const table of ['terms', 'term_revisions', 'changes'])
    for (const row of db.prepare(`SELECT rowid, body FROM ${table}`).all() as { rowid: number; body: string }[])
      db.prepare(`UPDATE ${table} SET body = ? WHERE rowid = ?`).run(strip(row.body), row.rowid);
  db.exec('DROP TABLE meta; PRAGMA user_version = 2;'); db.close();
  const reopened = new Store(filename); t.after(() => reopened.close());
  assert.match(reopened.logId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(reopened.terms('subjects').map(term => term.slug).sort(), ['root', 'root-2']);
  assert.equal(reopened.lookup(root.id, 2).slug, 'root');
  assert.equal((reopened.changes(1)[0].after as { slug?: string }).slug, 'root');
});

test('HTTP changes and state filter by scheme, carry the log id, and resolve slugs', async t => {
  const { store, humanities } = subjects(t);
  store.addScheme({ id: 'other', label: 'Other', hierarchy: 'poly' });
  store.addTerm({ scheme: 'other', label: 'Elsewhere' });
  const category = store.addTerm({ scheme: 'subjects', label: 'Bioinformatics', broader: [humanities.id] });
  const server = createApp(store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => { const res = await fetch(origin + path); return { status: res.status, body: await res.json() }; };
  const changes = await get('/api/changes?since=0&scheme=subjects');
  assert.equal(changes.body.log, store.logId);
  assert.deepEqual(changes.body.changes.map((change: { n: number }) => change.n), [1, 2, 3, 6]);
  const state = await get('/api/state?scheme=subjects');
  assert.equal(state.body.log, store.logId);
  assert.deepEqual(state.body.schemes.map((scheme: { id: string }) => scheme.id), ['subjects']);
  assert.equal(state.body.terms.length, 3);
  assert.equal((await get('/api/state?scheme=missing')).status, 404);
  assert.equal((await get('/api/schemes/subjects/slugs/bioinformatics?parent=humanities')).body.term.id, category.id);
  assert.equal((await get(`/api/schemes/subjects/slugs/bioinformatics?parent=${humanities.id}`)).body.current, true);
  assert.equal((await get('/api/schemes/subjects/slugs/nothing')).status, 404);
  assert.equal((await get('/api/schemes/subjects/slugs/humanities?depth=0')).body.term.id, humanities.id);
  assert.equal((await get('/api/changes?since=99')).status, 400);
});
