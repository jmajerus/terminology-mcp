import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { seedDemo } from '../src/seed.js';
import type { Term } from '../src/model.js';

function setup(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  return store;
}
function edit(term: Term, fields = {}) {
  return { label: term.label, scopeNote: term.scopeNote, altLabels: term.altLabels,
    status: term.status, links: term.links, relations: term.relations, expectedChanged: term.changed, ...fields };
}

test('creates stable IDs, derived hierarchy and historical revisions; no-op edits do not log', t => {
  const store = setup(t);
  const parent = store.addTerm({ scheme: 'subjects', label: 'Politics', status: 'active' });
  const child = store.addTerm({ scheme: 'subjects', label: 'Public opinion', broader: [parent.id] });
  assert.match(parent.id, /^t_[a-f0-9]{32}$/);
  assert.equal(child.path, 'politics/public-opinion');
  assert.equal(child.depth, 1);
  assert.deepEqual(store.lookup(parent.id).narrower, [child.id]);
  const version = store.version;
  assert.equal(store.editTerm(child.id, edit(child)).changed, child.changed);
  assert.equal(store.version, version);
  const updated = store.editTerm(child.id, edit(child, { scopeNote: 'Attitudes held by the public.' }));
  assert.equal(store.lookup(child.id, version).scopeNote, '');
  assert.equal(updated.scopeNote, 'Attitudes held by the public.');
  assert.equal(store.changes(version)[0].kind, 'noted');
  assert.equal(store.changes(version)[0].breaking, false);
  assert.throws(() => store.lookup(child.id, parent.created), /not found/);
  assert.deepEqual(store.schemes(0), []);
});

test('renaming an ancestor preserves old aliases, updates descendant aliases, and pins historical reads', t => {
  const store = setup(t);
  const root = store.addTerm({ scheme: 'subjects', label: 'Politics' });
  const child = store.addTerm({ scheme: 'subjects', label: 'Opinion', broader: [root.id] });
  const grandchild = store.addTerm({ scheme: 'subjects', label: 'Polling', broader: [child.id] });
  const before = store.version;
  store.editTerm(root.id, edit(root, { label: 'Political life', reason: 'Clarify scope.' }));
  assert.equal(store.lookup('subjects:politics/opinion/polling').id, grandchild.id);
  assert.equal(store.lookup('subjects:political-life/opinion/polling').id, grandchild.id);
  assert.equal(store.lookup(grandchild.id, before).path, 'politics/opinion/polling');
  assert.throws(() => store.lookup('subjects:political-life/opinion/polling', before), /not found/);
  const change = store.changes(before)[0];
  assert.equal(change.breaking, true);
  assert.equal(change.kind, 'labelled');
  assert.deepEqual(new Set(change.terms), new Set([root.id, child.id, grandchild.id]));
  assert.equal(store.lookup(child.id).changed, change.n);
});

test('alias conflicts roll back the whole edit, revision, and changelog', t => {
  const store = setup(t);
  const first = store.addTerm({ scheme: 'subjects', label: 'One' });
  store.editTerm(first.id, edit(first, { label: 'Two' }));
  const other = store.addTerm({ scheme: 'subjects', label: 'Three' });
  const before = store.version;
  assert.throws(() => store.editTerm(other.id, edit(other, { label: 'One' })), /Alias/);
  assert.equal(store.version, before);
  assert.equal(store.lookup(other.id).label, 'Three');
  assert.equal(store.changes(before).length, 0);
  assert.equal(store.lookup('subjects:one').id, first.id);
});

test('rejects stale writes and never silently overwrites an edit', t => {
  const store = setup(t);
  const term = store.addTerm({ scheme: 'subjects', label: 'One' });
  const saved = store.editTerm(term.id, edit(term, { scopeNote: 'First edit' }));
  assert.throws(() => store.editTerm(term.id, edit(term, { scopeNote: 'Stale edit' })), /changed since/);
  assert.equal(store.lookup(term.id).scopeNote, 'First edit');
  assert.equal(store.version, saved.changed);
});

test('enforces tree and polyhierarchy constraints and rejects unsupported structural edits', t => {
  const store = setup(t);
  const a = store.addTerm({ scheme: 'subjects', label: 'A' });
  const b = store.addTerm({ scheme: 'subjects', label: 'B' });
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'Child', broader: [a.id, b.id] }), /only one/);
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'A' }), /sibling/);
  store.addScheme({ id: 'concepts', label: 'Concepts', hierarchy: 'poly' });
  const p = store.addTerm({ scheme: 'concepts', label: 'P' });
  const q = store.addTerm({ scheme: 'concepts', label: 'Q' });
  const multi = store.addTerm({ scheme: 'concepts', label: 'PQ', broader: [p.id, q.id] });
  assert.equal(multi.path, null);
  assert.equal(multi.depth, 1);
  assert.throws(() => store.addTerm({ scheme: 'concepts', label: 'Mixed', broader: [a.id] }), /same scheme/);
  assert.throws(() => store.addTerm({ scheme: 'concepts', label: 'Repeated', broader: [p.id, p.id] }), /distinct/);
  assert.throws(() => store.editTerm(a.id, edit(a, { broader: [b.id] })));
  assert.throws(() => store.editTerm(a.id, edit(a, { status: 'retired' })));
});

test('validates relations and references, and marks relation removals as breaking', t => {
  const store = setup(t);
  const a = store.addTerm({ scheme: 'subjects', label: 'A' });
  store.addScheme({ id: 'concepts', label: 'Concepts', hierarchy: 'poly' });
  const b = store.addTerm({ scheme: 'concepts', label: 'B', relations: [{ type: 'related', target: a.id }] });
  assert.throws(() => store.editTerm(a.id, edit(a, { relations: [{ type: 'opposite', target: b.id }] })), /cross schemes/);
  assert.throws(() => store.editTerm(a.id, edit(a, { relations: [{ type: 'related', target: a.id }] })), /itself/);
  assert.throws(() => store.editTerm(a.id, edit(a, { links: [{ uri: 'javascript:alert(1)', match: 'exactMatch' }] })));
  assert.throws(() => store.editTerm(a.id, edit(a, { relations: [{ type: 'related', target: 'missing' }] })), /not found/);
  store.editTerm(b.id, edit(b, { relations: [] }));
  assert.equal(store.changes().at(-1)?.breaking, true);
});

test('persists data across reopen and demo seed is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'terminology-store-'));
  try {
    const filename = join(directory, 'nested', 'store.sqlite');
    const first = new Store(filename);
    seedDemo(first);
    const terms = first.terms();
    const version = first.version;
    first.close();
    const second = new Store(filename);
    try {
      seedDemo(second);
      assert.deepEqual(second.terms(), terms);
      assert.equal(second.version, version);
      assert.equal(second.schemes().length, 2);
      assert.ok(second.terms('human-work').some(term => term.broader.length === 2));
    } finally { second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rejects invalid versions, missing schemes, and duplicate explicit aliases atomically', t => {
  const store = setup(t);
  assert.throws(() => store.terms(undefined, 999), /Version/);
  assert.throws(() => store.terms(undefined, -1), /Version/);
  assert.throws(() => store.addTerm({ scheme: 'missing', label: 'A' }), /Scheme not found/);
  const a = store.addTerm({ scheme: 'subjects', label: 'A', aliases: ['legacy:a'] });
  const before = store.version;
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'B', aliases: ['legacy:a'] }), /Alias/);
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'B', aliases: [a.id] }), /shadow/);
  assert.equal(store.version, before);
  assert.equal(store.terms().length, 1);
});

test('non-Latin sibling labels retain distinct paths, including combining marks', t => {
  const store = setup(t);
  const cat = store.addTerm({ scheme: 'subjects', label: '猫' });
  const dog = store.addTerm({ scheme: 'subjects', label: '犬' });
  const hindi = store.addTerm({ scheme: 'subjects', label: 'किताब' });
  assert.equal(cat.path, '猫'); assert.equal(dog.path, '犬'); assert.equal(hindi.path, 'किताब');
  assert.equal(store.lookup('subjects:猫').id, cat.id);
  assert.equal(store.lookup('subjects:犬').id, dog.id);
});

for (const edge of ['broader', 'replacedBy'] as const) {
  for (const reverse of [false, true]) {
    test(`${edge} depth boundary is independent of ${reverse ? 'child' : 'parent'}-first import order`, () => {
      const plan = (count: number) => {
        const terms = Array.from({ length: count }, (_, index) => ({
          key: `urn:depth:${index}`, label: edge === 'broader' ? 'Node' : `Node ${index}`,
          status: edge === 'replacedBy' ? 'retired' : 'active',
          [edge]: index ? [`urn:depth:${index - 1}`] : [],
        }));
        return { scheme: { id: 'depth', label: 'Depth', hierarchy: 'tree' }, terms: reverse ? terms.reverse() : terms };
      };
      const store = new Store(':memory:');
      try {
        assert.throws(() => store.importScheme(plan(502), 0), /depth of 500/);
        assert.equal(store.version, 0); assert.equal(store.schemes().length, 0);
        assert.equal(store.importScheme(plan(501), 0).count, 501);
        if (edge === 'broader') assert.equal(store.lookup('urn:depth:500').depth, 500);
      } finally { store.close(); }
    });
  }
}
