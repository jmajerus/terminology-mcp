import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { authorizeRequest, type RequestAccessConfig } from '../src/access.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const issuer = 'https://example.cloudflareaccess.com';
const config: RequestAccessConfig = { teamDomain: issuer, lanHosts: ['terminology-mcp.localdomain'] };
const { privateKey, publicKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] });
async function token(aud = 'mcp-aud', overrides: Record<string, unknown> = {}, key = privateKey) {
  return new SignJWT({ sub: 'user', email: 'owner@example.com', iss: issuer, aud,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
}
const request = (headers: Record<string, string> = {}, peer = '127.0.0.1') => ({
  headers: { host: 'public.example', ...headers }, socket: { remoteAddress: peer },
}) as IncomingMessage;

test('Access accepts a token from any application in the team, on every route', async () => {
  const mcp = request({ 'cf-access-jwt-assertion': await token() });
  const admin = request({ 'cf-access-jwt-assertion': await token('admin-aud') });
  const recreated = request({ 'cf-access-jwt-assertion': await token('a-recreated-application') });
  for (const path of ['/mcp', '/admin', '/', '/api/state', '/app.js'])
    for (const req of [mcp, admin, recreated]) assert.equal((await authorizeRequest(req, path, config, keys)).via, 'access');
});

test('Access rejects expired, premature, wrong-issuer, forged and incomplete JWTs', async () => {
  const other = await generateKeyPair('RS256');
  for (const value of [
    await token('mcp-aud', { exp: 1 }), await token('mcp-aud', { nbf: Math.floor(Date.now()/1000)+600 }),
    await token('mcp-aud', { iss: 'https://evil.example' }), await token('mcp-aud', {}, other.privateKey),
    await token('mcp-aud', { sub: '' }), await token('mcp-aud', { exp: undefined }), 'invalid',
  ]) await assert.rejects(authorizeRequest(request({ 'cf-access-jwt-assertion': value }), '/mcp', config, keys), { status: 403 });
});

test('only direct private peers naming a LAN host can bypass Access; proxy headers and public hosts cannot', async () => {
  for (const [host, peer] of [['localhost', '127.0.0.1'], ['terminology-mcp.localdomain:8000', '192.168.1.20'], ['[::1]:8000', '::1']])
    assert.equal((await authorizeRequest(request({ host }, peer), '/mcp', config, keys)).via, 'lan');
  // Proxy headers without an assertion make a read-only visitor, never a LAN caller.
  const proxyHeaders: Record<string, string>[] = [{ host: 'localhost', 'cf-ray': 'edge' },
    {host:'localhost','cf-connecting-ip':'192.168.1.2'}, {host:'localhost','cdn-loop':'cloudflare'}];
  for (const headers of proxyHeaders)
    assert.equal((await authorizeRequest(request(headers), '/mcp', config, keys)).via, 'public');
  await assert.rejects(authorizeRequest(request({}), '/mcp', config, keys), { status: 401 });
  // An empty assertion still marks a proxied request, and is refused as invalid.
  await assert.rejects(authorizeRequest(request({ host: 'localhost', 'cf-access-jwt-assertion': '' }), '/mcp', config, keys), { status: 403 });
  await assert.rejects(authorizeRequest(request({host:'localhost'}, '203.0.113.1'), '/mcp', config, keys), {status:401});
  await assert.rejects(authorizeRequest(request({host:'evil.example@localhost'}), '/mcp', config, keys), {status:400});
  await assert.rejects(authorizeRequest(request({'cf-access-jwt-assertion':await token()}), '/mcp', {...config,teamDomain:undefined}, keys), {status:503});
});

test('HTTP routes enforce Access before writes and MCP while visitors read and local health remains usable', async t => {
  const store = new Store(':memory:');
  const server = createApp(store, { origins: ['http://public.example'], access: config, accessKeys: keys });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const mcp=await token(),admin=await token('admin-aud');
  const send=(path:string,value?:string,body?:unknown)=>fetch(base+path,{
    method:body?'POST':'GET',headers:{Host:'public.example','cf-ray':'test',Accept:'application/json, text/event-stream',
      'Content-Type':'application/json',...(value?{'cf-access-jwt-assertion':value}:{})},body:body?JSON.stringify(body):undefined,
  });
  assert.equal((await send('/api/state')).status,200);
  assert.equal((await send('/api/state',mcp)).status,200);
  assert.equal((await send('/api/state',admin)).status,200);
  assert.equal((await send('/admin',admin)).status,200);
  assert.equal((await send('/api/schemes',undefined,{id:'forbidden',label:'Forbidden',hierarchy:'tree'})).status,401);
  assert.equal(store.version,0);
  const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}};
  assert.equal((await send('/mcp',undefined,init)).status,401);
  const result=await send('/mcp',admin,init);assert.equal(result.status,200);assert.ok((await result.json()).result.capabilities.tools);
  assert.equal((await fetch(base+'/health')).status,200);
});

test('Access callers are named by their verified identity when proposing', async t => {
  const store = new Store(':memory:');
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  store.addTerm({ scheme: 'subjects', label: 'Sciences' });
  store.addScheme({ id: 'reference', label: 'Reference', hierarchy: 'poly' });
  store.addTerm({ scheme: 'reference', label: 'Geography', notations: [{ value: 'G1' }] });
  const server = createApp(store, { origins: ['http://public.example'], access: config, accessKeys: keys });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const response = await fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/proposals', { method: 'POST',
    headers: { Host: 'public.example', 'cf-ray': 'test', 'Content-Type': 'application/json', 'cf-access-jwt-assertion': await token() },
    body: JSON.stringify({ scheme: 'subjects', source: 'G1', broader: 'sciences', proposer: 'someone-else' }) });
  assert.equal(response.status, 201);
  assert.equal(store.changes(store.version - 1)[0].author, 'owner@example.com');
  assert.equal(store.lookup((await response.json()).id).proposal?.proposer, 'owner@example.com');
});

test('a proxied request without an assertion is a visitor; a present assertion must still be valid', async () => {
  assert.equal((await authorizeRequest(request({ 'cf-ray': 'x' }), '/', config, keys)).via, 'public');
  assert.equal((await authorizeRequest(request({ 'cf-access-jwt-assertion': await token() }), '/', config, keys)).via, 'access');
  // The Access cookie isn't a credential: editing happens on the owner's hostname, which forwards an assertion.
  assert.equal((await authorizeRequest(request({ 'cf-ray': 'x', cookie: `CF_Authorization=${await token()}` }), '/', config, keys)).via, 'public');
  for (const value of ['invalid', '']) await assert.rejects(authorizeRequest(request({ 'cf-access-jwt-assertion': value }), '/', config, keys), { status: 403 });
  // Without proxy headers, a public host from a loopback peer is neither LAN nor visitor.
  await assert.rejects(authorizeRequest(request({ cookie: `CF_Authorization=${await token()}` }), '/', config, keys), { status: 401 });
});

test('public read serves reads without emails, and refuses writes, MCP and subscribers', async t => {
  const store = new Store(':memory:');
  store.addScheme({ id: 'subjects', label: 'Subjects', hierarchy: 'tree' });
  const sciences = store.addTerm({ scheme: 'subjects', label: 'Sciences' });
  store.addScheme({ id: 'reference', label: 'Reference', hierarchy: 'poly' });
  store.addTerm({ scheme: 'reference', label: 'Geography', notations: [{ value: 'G1' }] });
  store.propose({ scheme: 'subjects', source: 'G1', broader: sciences.id }, 'owner@example.com');
  const server = createApp(store, { origins: ['http://public.example'], access: config, accessKeys: keys,
    editUrl: 'https://owner.example' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const send = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) => fetch(base + path, { redirect: 'manual', ...init,
    headers: { Host: 'public.example', 'cf-ray': 'test', 'Content-Type': 'application/json', ...headers } });

  const viewer = await (await send('/api/viewer')).json();
  assert.deepEqual(viewer, { canEdit: false, via: 'public', edit: 'https://owner.example' });
  for (const path of ['/', '/viewer.js', '/api/state', '/api/changes', '/api/schemes/subjects/skos']) assert.equal((await send(path)).status, 200, path);
  const text = await (await send('/api/changes')).text() + await (await send('/api/state')).text();
  assert.ok(!text.includes('owner@example.com') && text.includes('an editor'));

  const write = await send('/api/terms', { method: 'POST', body: JSON.stringify({ scheme: 'subjects', label: 'Arts' }) });
  assert.deepEqual([write.status, (await write.json()).edit], [401, 'https://owner.example']);
  assert.equal((await send('/mcp', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await send('/api/subscribers')).status, 401);
  // The owner, with an assertion from the owner's hostname, edits and sees authors.
  const owner = { 'cf-access-jwt-assertion': await token() };
  assert.deepEqual(await (await send('/api/viewer', {}, owner)).json(),
    { canEdit: true, via: 'access', name: 'owner@example.com', signOut: '/cdn-cgi/access/logout' });
  const created = await send('/api/terms', { method: 'POST', body: JSON.stringify({ scheme: 'subjects', label: 'Arts' }) }, owner);
  assert.equal(created.status, 201);
  assert.match(await (await send('/api/changes', {}, owner)).text(), /owner@example\.com/);
});

test('a proxied request is served under its own HTTPS hostname; direct requests still need a configured one', async t => {
  const store = new Store(':memory:');
  const server = createApp(store, { access: config, accessKeys: keys });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const port = (server.address() as AddressInfo).port;
  // fetch drops a custom Host header, so these requests use node:http.
  const send = (headers: Record<string, string>, body?: unknown) => new Promise<{ status: number }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: body ? 'POST' : 'GET', path: body ? '/api/schemes' : '/api/viewer',
      headers: { Host: 'vocabulary.example', 'Content-Type': 'application/json', ...headers } }, res => { res.resume(); resolve({ status: res.statusCode! }); });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await send({ 'cf-ray': 'x' })).status, 200);
  assert.equal((await send({})).status, 403);
  const owner = { 'cf-access-jwt-assertion': await token() };
  const scheme = { id: 'subjects', label: 'Subjects', hierarchy: 'tree' };
  assert.equal((await send({ ...owner, Origin: 'https://evil.example' }, scheme)).status, 403);
  assert.equal((await send({ ...owner, Origin: 'http://vocabulary.example' }, scheme)).status, 403);
  assert.equal((await send({ ...owner, Origin: 'https://vocabulary.example' }, scheme)).status, 201);
});
