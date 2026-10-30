import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, requestOrigin } from '../src/http-config.js';

test('LAN origins are explicit while localhost remains available for health checks', () => {
  const origins = allowedOrigins(['http://terminology-mcp:3210', 'http://terminology-mcp.localdomain:3210']);
  assert.equal(requestOrigin('terminology-mcp:3210', origins), 'http://terminology-mcp:3210');
  assert.equal(requestOrigin('terminology-mcp.localdomain:3210', origins), 'http://terminology-mcp.localdomain:3210');
  assert.equal(requestOrigin('127.0.0.1:3210', origins), 'http://127.0.0.1:3210');
  assert.equal(requestOrigin('untrusted.example:3210', origins), null);
  assert.equal(requestOrigin('terminology-mcp:8888', origins), null);
  assert.equal(requestOrigin('evil.example@localhost:3210', origins), null);
  assert.equal(requestOrigin('localhost:3210/extra', origins), null);
  assert.equal(requestOrigin(undefined, origins), null);
  assert.throws(() => allowedOrigins(['http://user:password@host:3210']));
  assert.throws(() => allowedOrigins(['http://host:3210/path']));
  assert.throws(() => allowedOrigins(['http://host:3210', 'https://host:3210']));
});
