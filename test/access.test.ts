import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
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
  const proxyHeaders: Record<string, string>[] = [{}, { host: 'localhost', 'cf-ray': 'edge' }, { host: 'localhost', 'cf-access-jwt-assertion': '' },
    {host:'localhost','cf-connecting-ip':'192.168.1.2'}, {host:'localhost','cdn-loop':'cloudflare'}];
  for (const headers of proxyHeaders)
    await assert.rejects(authorizeRequest(request(headers), '/mcp', config, keys), { status: 401 });
  await assert.rejects(authorizeRequest(request({host:'localhost'}, '203.0.113.1'), '/mcp', config, keys), {status:401});
  await assert.rejects(authorizeRequest(request({host:'evil.example@localhost'}), '/mcp', config, keys), {status:400});
  await assert.rejects(authorizeRequest(request({'cf-access-jwt-assertion':await token()}), '/mcp', {...config,teamDomain:undefined}, keys), {status:503});
});

test('HTTP routes enforce Access before reads or writes while local health and MCP remain usable', async t => {
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
  assert.equal((await send('/api/state')).status,401);
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
