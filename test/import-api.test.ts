import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { parseRdf, SKOS } from '../src/skos.js';

test('UI import preview and apply accept a previously deleted scheme identifier', async t => {
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown) => fetch(`${base}/api/imports/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const input = { format: 'turtle', schemeId: 'research', sourceScheme: 'https://example.org/scheme', language: 'en', hierarchy: 'tree',
    data: readFileSync(new URL('./fixtures/research.ttl', import.meta.url), 'utf8') };
  let previewResponse = await post('preview', input);
  assert.equal(previewResponse.status, 200);
  let preview = await previewResponse.json();
  assert.equal((await post('apply', { plan: preview.plan, expectedVersion: preview.expectedVersion })).status, 201);
  const oldRoot = store.lookup('https://example.org/root');
  const originalVersion = store.version;
  store.deleteScheme('research', store.version);
  const deletedVersion = store.version;
  previewResponse = await post('preview', input);
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  preview = await previewResponse.json();
  assert.equal(store.version, deletedVersion);
  assert.equal(store.schemes().length, 0);
  assert.equal((await post('apply', { plan: preview.plan, expectedVersion: preview.expectedVersion })).status, 201);
  assert.notEqual(store.lookup('https://example.org/root').id, oldRoot.id);
  assert.equal(store.lookup('https://example.org/root', originalVersion).id, oldRoot.id);
  const state = await (await fetch(`${base}/api/state?scheme=research`)).json();
  assert.equal(state.terms.length, 3);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.schemes, 1);
  assert.equal(health.terms, 3);
});

test('file import and structural preview API enforce atomic writes, stale preview rejection, and versioned export', async t => {
  const store = new Store(':memory:');
  const server = createApp(store); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (path: string, data: unknown) => fetch(`${base}/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const data = readFileSync(new URL('./fixtures/research.ttl', import.meta.url), 'utf8');
  const schemes = await (await post('imports/schemes', { format: 'turtle', data })).json();
  assert.equal(schemes.schemes[0].uri, 'https://example.org/scheme');
  const previewResponse = await post('imports/preview', { format: 'turtle', data, schemeId: 'research',
    sourceScheme: 'https://example.org/scheme', language: 'en', hierarchy: 'tree' });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.count, 3); assert.equal(store.version, 0);
  const applied = await post('imports/apply', { plan: preview.plan, expectedVersion: 0 });
  assert.equal(applied.status, 201);
  const root = store.lookup('https://example.org/root');
  const child = store.lookup('https://example.org/child');
  const n = store.version;
  const operation = { kind: 'move', expectedVersion: n, broader: [] };
  const movedPreview = await post(`terms/${child.id}/operations/preview`, operation);
  assert.equal(movedPreview.status, 200); assert.equal(store.version, n);
  assert.deepEqual(store.lookup(child.id).broader, [root.id]);
  store.addTerm({ scheme: 'research', label: 'A concurrent addition' });
  assert.equal((await post(`terms/${child.id}/operations/apply`, operation)).status, 409);
  const version = store.version;
  assert.equal((await post(`terms/${child.id}/operations/apply`, { ...operation, expectedVersion: version })).status, 200);
  const historical = await fetch(`${base}/schemes/research/skos?at=${n}`);
  assert.equal(historical.status, 200); assert.match(historical.headers.get('content-type')!, /text\/turtle/);
  assert.equal(parseRdf(await historical.text()).countQuads(child.sourceUri!, SKOS + 'broader', null, null), 1);
  assert.equal((await fetch(`${base}/schemes/missing/skos`)).status, 404);
  assert.equal((await post('imports/preview', { format: 'turtle', data: 'bad', schemeId: 'bad',
    sourceScheme: 'urn:test', hierarchy: 'tree' })).status, 422);
});
