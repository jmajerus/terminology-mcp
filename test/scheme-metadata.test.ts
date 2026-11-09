import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('scheme name and description edits are versioned, partial and conflict checked', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.addScheme({ id: 'example', label: 'Original', description: 'Original description', hierarchy: 'tree' });
  const term = store.addTerm({ scheme: 'example', label: 'Root' });
  const before = store.version;
  const renamed = store.updateScheme('example', { label: '  Renamed  ', expectedVersion: before });
  assert.equal(renamed.label, 'Renamed');
  assert.equal(renamed.description, 'Original description');
  assert.equal(renamed.id, 'example');
  assert.deepEqual(store.lookup(term.id), term);
  assert.equal(store.schemes(before)[0].label, 'Original');
  assert.equal(store.changes(before)[0].kind, 'scheme-changed');
  assert.equal(store.changes(before)[0].breaking, false);
  assert.throws(() => store.updateScheme('example', { description: 'Stale', expectedVersion: before }), /workspace changed/);
  const version = store.version;
  for (const fields of [{ label: ' ' }, { label: 'x'.repeat(201) }, { description: 'x'.repeat(10001) }, { id: 'other' }]) {
    assert.throws(() => store.updateScheme('example', { ...fields, expectedVersion: version }));
    assert.equal(store.version, version);
  }
  store.updateScheme('example', { description: '  New description  ', expectedVersion: store.version });
  assert.equal(store.schemes()[0].label, 'Renamed');
  assert.equal(store.schemes()[0].description, 'New description');
  store.updateScheme('example', { description: '', expectedVersion: store.version });
  assert.equal(store.schemes()[0].description, '');
  const head = store.version;
  store.updateScheme('example', { label: 'Renamed', description: '', expectedVersion: head });
  assert.equal(store.version, head);
});
