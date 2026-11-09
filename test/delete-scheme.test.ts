import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('deleted schemes can be reimported with their IDs, source IRIs, aliases and collections', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const plan = {
    scheme: { id: 'example', label: 'Example', hierarchy: 'tree', sourceUri: 'https://example.org/scheme' },
    terms: [{ key: 'https://example.org/root', label: 'Root', aliases: ['external-root'] },
      { key: 'https://example.org/old', label: 'Old child', broader: ['https://example.org/root'] }],
    sets: [{ key: 'https://example.org/collection', slug: 'selected', label: 'Selected', members: ['https://example.org/root'] }],
  };
  const first = store.importScheme(plan, store.version);
  const original = store.lookup('external-root'), oldChild = store.lookup('https://example.org/old');
  const originalVersion = store.version;
  store.deleteScheme('example', store.version);
  const deletedVersion = store.version;
  const replacement = { ...plan, terms: [plan.terms[0]] };
  store.preview(() => store.importScheme(replacement, store.version));
  assert.equal(store.version, deletedVersion);
  assert.equal(store.schemes().length, 0);
  assert.throws(() => store.lookup('external-root'), /not found/);
  assert.equal(store.lookup('external-root', originalVersion).id, original.id);
  // A failed reimport must restore the tombstone and all old history.
  assert.throws(() => store.importScheme({ ...replacement, sets: [{ ...plan.sets[0], members: ['https://example.org/missing'] }] }, store.version), /Unresolved/);
  assert.equal(store.version, deletedVersion);
  assert.equal(store.schemes().length, 0);
  const second = store.importScheme(replacement, store.version);
  const current = store.lookup('external-root');
  assert.notEqual(current.id, original.id);
  assert.equal(store.lookup('https://example.org/root').id, current.id);
  assert.equal(store.lookup('example:root').id, current.id);
  assert.equal(store.terms().length, 1);
  assert.throws(() => store.lookup(oldChild.id), /not found/);
  assert.throws(() => store.lookup(original.id), /not found/);
  assert.equal(store.terms('example', originalVersion).length, 2);
  assert.equal(store.terms('example', deletedVersion).length, 0);
  assert.equal(store.schemes(deletedVersion).length, 0);
  assert.equal(store.lookup('example:root', originalVersion).id, original.id);
  assert.notEqual(first.sets[0].id, second.sets[0].id);
  assert.deepEqual(store.expandSet(second.sets[0].id).terms.map(term => term.id), [current.id]);
  assert.equal(store.conceptSet(first.sets[0].id, originalVersion).members[0], original.id);
  assert.throws(() => store.addScheme(plan.scheme), /already exists/);
  store.deleteScheme('example', store.version);
  store.addScheme({ id: 'example', label: 'Empty replacement', hierarchy: 'graph' });
  assert.equal(store.terms('example').length, 0);
  assert.equal(store.sets('example').length, 0);
  assert.equal(store.lookup(current.id, second.version).id, current.id);
});

test('scheme deletion is atomic, versioned and visible to subscribed consumers', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.addScheme({ id: 'one', label: 'One', hierarchy: 'tree' });
  store.addScheme({ id: 'two', label: 'Two', hierarchy: 'graph' });
  const root = store.addTerm({ scheme: 'one', label: 'Root' });
  const child = store.addTerm({ scheme: 'one', label: 'Child', broader: [root.id] });
  const survivor = store.addTerm({ scheme: 'two', label: 'Other', relations: [{ type: 'related', target: child.id }] });
  const set = store.saveSet({ scheme: 'one', slug: 'example', label: 'Example', members: [child.id] }, store.version);
  const before = store.version;
  store.reportProgress('consumer', { log: store.logId, through: before, schemes: ['one'] });
  const preview = store.preview(() => store.deleteScheme('one', before));
  assert.equal(preview.terms, 2);
  assert.equal(preview.sets, 1);
  assert.equal(preview.relatedTerms, 1);
  assert.equal(store.version, before);
  assert.equal(store.lookup(child.id).path, 'root/child');
  assert.throws(() => store.deleteScheme('one', before - 1), /workspace changed/);
  assert.throws(() => store.deleteScheme('missing', before), /not found/);
  assert.equal(store.version, before);
  assert.deepEqual(store.deleteScheme('one', before), preview);
  assert.deepEqual(store.schemes().map(s => s.id), ['two']);
  assert.deepEqual(store.terms().map(term => term.id), [survivor.id]);
  assert.deepEqual(store.lookup(survivor.id).relations, []);
  assert.equal(store.sets().length, 0);
  assert.throws(() => store.lookup(child.id), /not found/);
  assert.throws(() => store.addTerm({ scheme: 'one', label: 'No' }), /not found/);
  assert.equal(store.lookup(child.id, before).path, 'root/child');
  assert.equal(store.schemes(before).length, 2);
  assert.equal(store.conceptSet(set.id, before).members[0], child.id);
  assert.equal(store.lookup(survivor.id, before).relations[0].target, child.id);
  const change = store.changes(before, undefined, 'one')[0];
  assert.equal(change.kind, 'scheme-deleted');
  assert.equal(change.breaking, true);
  assert.equal(change.beforeTerms?.length, 3);
  assert.equal(change.afterTerms?.length, 1);
  assert.equal(store.subscriber('consumer').pendingBreaking, 1);
  assert.equal(store.reportProgress('consumer', { log: store.logId, through: store.version, schemes: ['one'] }).pending, 0);
  // Subsequent writes validate only the remaining current workspace.
  store.addTerm({ scheme: 'two', label: 'Still works' });
});

test('CLI previews by default, applies with --yes and survives reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-scheme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'store.sqlite');
  const store = new Store(filename);
  store.addScheme({ id: 'example', label: 'Example', hierarchy: 'graph' });
  store.addTerm({ scheme: 'example', label: 'Example term' });
  let before = store.version;
  store.close();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'delete', ...args], { encoding: 'utf8' });
  const rename = (...args: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'rename', 'example', ...args, '--db', filename], { encoding: 'utf8' });
  assert.equal(rename('New name').status, 0);
  let renamed = new Store(filename);
  assert.equal(renamed.schemes()[0].label, 'Example');
  assert.equal(renamed.version, before);
  renamed.close();
  const changed = rename('New name', '--yes');
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).scheme.label, 'New name');
  renamed = new Store(filename);
  assert.equal(renamed.schemes()[0].id, 'example');
  assert.equal(renamed.schemes()[0].label, 'New name');
  before = renamed.version;
  renamed.close();
  assert.equal(JSON.parse(rename('New name', '--yes').stdout).version, before);
  assert.equal(rename(' ', '--yes').status, 1);
  assert.equal(run('--help').status, 0);
  const preview = run('example', '--db', filename);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /"applied": false/);
  let reopened = new Store(filename);
  assert.equal(reopened.version, before);
  reopened.close();
  const applied = run('example', '--db', filename, '--yes');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, true);
  reopened = new Store(filename);
  assert.equal(reopened.schemes().length, 0);
  assert.equal(reopened.terms().length, 0);
  assert.equal(reopened.terms(undefined, before).length, 1);
  reopened.close();
  assert.equal(run('example', '--db', filename, '--yes').status, 1);
  assert.equal(run('example', '--db', join(dir, 'missing.sqlite'), '--yes').status, 1);
  assert.equal(run('example', '--unknown').status, 1);
});
