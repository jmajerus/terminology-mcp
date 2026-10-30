import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('HTTP API supports empty setup, edits, historical reads, validation, and local-only write protection', async t => {
  const store = new Store(':memory:');
  const server = createApp(store);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', value?: unknown, headers = {}) => fetch(`${origin}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const empty = await (await request('/api/state')).json();
  assert.equal(empty.version, 0);
  assert.deepEqual(empty.schemes, []);
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Taxonomy editor/);
  for (const asset of ['/app.js', '/style.css']) assert.equal((await request(asset)).status, 200);
  assert.equal((await request('/api/schemes', 'POST', { id: 'subjects', label: 'Subjects', hierarchy: 'tree' })).status, 201);
  const added = await request('/api/terms', 'POST', { scheme: 'subjects', label: 'Biology' });
  assert.equal(added.status, 201);
  const { term } = await added.json();
  const edited = await request(`/api/terms/${term.id}`, 'PATCH', {
    label: term.label, scopeNote: 'Living systems.', expectedChanged: term.changed,
  });
  assert.equal(edited.status, 200);
  const historical = await (await request(`/api/terms/${term.id}?at=${term.changed}`)).json();
  assert.equal(historical.term.scopeNote, '');
  const alias = await (await request('/api/terms/subjects%3Abiology')).json();
  assert.equal(alias.term.id, term.id);
  assert.equal((await request(`/api/terms/${term.id}`, 'PATCH', { label: 'Stale', expectedChanged: term.changed })).status, 409);
  assert.equal((await request('/api/terms', 'POST', { scheme: 'subjects', label: '' })).status, 422);
  assert.equal((await request('/api/state?at=invalid')).status, 400);
  assert.equal((await request('/api/state?at=999')).status, 400);
  assert.equal((await request('/api/unknown')).status, 404);
  assert.equal((await request('/api/schemes', 'POST', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await request('/api/schemes', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  const invalid = await fetch(`${origin}/api/schemes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
    get(`${origin}/api/state`, { headers: { Host: 'untrusted.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(invalidHost, 403);
  const history = await (await request('/api/changes?since=1')).json();
  assert.deepEqual(history.changes.map((change: { n: number }) => change.n), [2, 3]);
});
