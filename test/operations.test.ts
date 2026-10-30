import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  const a = store.addTerm({ scheme: 'subjects', label: 'A' });
  const b = store.addTerm({ scheme: 'subjects', label: 'B' });
  const child = store.addTerm({ scheme: 'subjects', label: 'Child', broader: [a.id] });
  const leaf = store.addTerm({ scheme: 'subjects', label: 'Leaf', broader: [child.id] });
  store.addScheme({ id: 'concepts', label: 'Concepts', hierarchy: 'poly' });
  const external = store.addTerm({ scheme: 'concepts', label: 'External', relations: [{ type: 'related', target: a.id }] });
  return { store, a, b, child, leaf, external };
}
test('move preview rolls back; apply preserves descendant aliases and history; stale preview is rejected', t => {
  const { store, a, b, child, leaf } = fixture(t);
  const n = store.version;
  const op = { kind: 'move', broader: [b.id], expectedVersion: n };
  const preview = store.preview(() => store.operate(a.id, op));
  assert.equal(store.version, n);
  assert.equal(store.lookup(leaf.id).path, 'a/child/leaf');
  assert.equal(preview.affected.length, 3);
  assert.equal(preview.affected.find(row => row.after.id === leaf.id)?.after.path, 'b/a/child/leaf');
  store.operate(a.id, op);
  assert.equal(store.lookup('subjects:a/child/leaf').id, leaf.id);
  assert.equal(store.lookup('subjects:b/a/child/leaf').id, leaf.id);
  assert.equal(store.lookup(child.id, n).path, 'a/child');
  assert.equal(store.changes(n)[0].afterTerms?.length, 3);
  assert.throws(() => store.operate(a.id, op), /workspace changed/);
});
test('merge retires the source, reparents children and redirects cross-scheme incoming relations atomically', t => {
  const { store, a, b, child, external } = fixture(t);
  const n = store.version;
  const result = store.operate(a.id, { kind: 'merge', target: b.id, expectedVersion: n });
  assert.equal(result.term.status, 'retired');
  assert.deepEqual(result.term.replacedBy, [b.id]);
  assert.deepEqual(store.lookup(child.id).broader, [b.id]);
  assert.deepEqual(store.lookup(external.id).relations, [{ type: 'related', target: b.id }]);
  assert.ok(store.lookup(b.id).altLabels.includes('A'));
  assert.equal(store.lookup(a.id, n).status, 'provisional');
  assert.equal(store.lookup('subjects:a').status, 'retired');
  assert.throws(() => store.editTerm(a.id, { label: 'New', expectedChanged: result.version }), /read-only/);
});
test('split requires explicit child assignment, transfers cross-scheme links, and preserves retired identity', t => {
  const { store, a, child, external } = fixture(t);
  const n = store.version;
  const input = { kind: 'split', expectedVersion: n,
    newTerms: [{ label: 'A one' }, { label: 'A two' }], children: [] };
  assert.throws(() => store.operate(a.id, input), /Assign every/);
  assert.equal(store.version, n);
  const result = store.operate(a.id, { ...input, children: [{ id: child.id, targets: [1] }] });
  const ids = result.term.replacedBy;
  assert.equal(ids.length, 2);
  assert.deepEqual(store.lookup(child.id).broader, [ids[1]]);
  assert.deepEqual(new Set(store.lookup(external.id).relations.map(r => r.target)), new Set(ids));
  assert.equal(store.lookup(ids[0]).label, 'A one');
  assert.equal(store.lookup(a.id).status, 'retired');
});
test('retirement promotes children and removes dangling incoming relations when no replacement is provided', t => {
  const { store, a, child, external } = fixture(t);
  store.operate(a.id, { kind: 'retire', expectedVersion: store.version, replacements: [] });
  assert.deepEqual(store.lookup(child.id).broader, []);
  assert.deepEqual(store.lookup(external.id).relations, []);
  assert.equal(store.lookup(a.id).status, 'retired');
});
test('cycles, descendant merges, and alias collisions fail without changing revisions or the log', t => {
  const { store, a, b, leaf } = fixture(t);
  const n = store.version;
  assert.throws(() => store.operate(a.id, { kind: 'move', broader: [leaf.id], expectedVersion: n }), /cycle/);
  assert.throws(() => store.operate(a.id, { kind: 'merge', target: leaf.id, expectedVersion: n }), /descendant/);
  store.operate(a.id, { kind: 'move', broader: [b.id], expectedVersion: n });
  const before = store.version;
  // A's former root path remains reserved even after moving away.
  assert.throws(() => store.addTerm({ scheme: 'subjects', label: 'A' }), /Alias/);
  assert.equal(store.version, before);
  assert.deepEqual(store.lookup(a.id).broader, [b.id]);
});

test('moving back over existing aliases records every descendant path and revision change', t => {
  const { store, a, b, child, leaf } = fixture(t);
  store.operate(a.id, { kind: 'move', broader: [b.id], expectedVersion: store.version });
  const before = store.version;
  const aliases = store.lookup(leaf.id).aliases;
  const op = { kind: 'move', broader: [], expectedVersion: before };
  const preview = store.preview(() => store.operate(a.id, op));
  assert.deepEqual(new Set(preview.affected.map(row => row.after.id)), new Set([a.id, child.id, leaf.id]));
  assert.equal(store.lookup(leaf.id).path, 'b/a/child/leaf');
  const result = store.operate(a.id, op);
  assert.deepEqual(store.lookup(leaf.id).aliases, aliases);
  assert.equal(store.lookup(leaf.id).path, 'a/child/leaf');
  assert.equal(store.lookup(leaf.id).changed, result.version);
  assert.equal(store.lookup(child.id).changed, result.version);
  assert.equal(store.lookup(leaf.id, before).path, 'b/a/child/leaf');
  assert.equal(store.changes(before)[0].afterTerms?.length, 3);
});

test('renaming an ancestor back to a known alias also advances descendant revisions', t => {
  const { store, a, leaf } = fixture(t);
  const rename = (label: string) => store.editTerm(a.id, { label, expectedChanged: store.lookup(a.id).changed });
  rename('Renamed');
  const before = store.version;
  const result = rename('A');
  assert.equal(store.lookup(leaf.id).changed, result.changed);
  assert.equal(store.lookup(leaf.id, before).path, 'renamed/child/leaf');
  assert.equal(store.lookup(leaf.id).path, 'a/child/leaf');
  assert.ok(store.changes(before)[0].terms.includes(leaf.id));
});
