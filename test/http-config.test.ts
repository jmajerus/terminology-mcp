import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, requestOrigin } from '../src/http-config.js';

test('LAN origins are explicit while localhost remains available for health checks', () => {
  const origins = allowedOrigins(['http://terminology-mcp:8000', 'http://terminology-mcp.localdomain:8000']);
  assert.equal(requestOrigin('terminology-mcp:8000', origins), 'http://terminology-mcp:8000');
  assert.equal(requestOrigin('terminology-mcp.localdomain:8000', origins), 'http://terminology-mcp.localdomain:8000');
  assert.equal(requestOrigin('127.0.0.1:8000', origins), 'http://127.0.0.1:8000');
  assert.equal(requestOrigin('untrusted.example:8000', origins), null);
  assert.equal(requestOrigin('terminology-mcp:8888', origins), null);
  assert.equal(requestOrigin('evil.example@localhost:8000', origins), null);
  assert.equal(requestOrigin('localhost:8000/extra', origins), null);
  assert.equal(requestOrigin(undefined, origins), null);
  assert.throws(() => allowedOrigins(['http://user:password@host:8000']));
  assert.throws(() => allowedOrigins(['http://host:8000/path']));
  assert.throws(() => allowedOrigins(['http://host:8000', 'https://host:8000']));
});
