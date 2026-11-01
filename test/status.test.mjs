import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus, statusUrl } from '../tools/terminology-status.mjs';

const commit = 'a'.repeat(40), head = 'b'.repeat(40);
const health = { ok: true, version: 3, schemes: 1, terms: 2,
  deployed: { branch: 'feature/codes', commit, pr: 4, at: '2026-10-30T00:00:00Z' } };
test('probe shows the deployed PR, current state, lag, and link to the editor', () => {
  const current = formatStatus(health, { prState: 'OPEN', head: commit });
  assert.equal(current.level, 'ok'); assert.match(current.text, /#4/);
  assert.equal(current.open, 'http://terminology-mcp.localdomain:8000');
  const behind = formatStatus(health, { prState: 'OPEN', head, comparison: { status: 'ahead', ahead_by: 3 } });
  assert.equal(behind.level, 'warn'); assert.match(behind.text, /↓3/);
  assert.equal(formatStatus(health, { prState: 'OPEN', head, comparison: null }).level, 'warn');
  assert.equal(formatStatus(health, { prState: 'OPEN', head, comparison: { status: 'diverged', ahead_by: 3 } }).level, 'warn');
});
test('merged/closed PRs, missing metadata, and unavailable heads are warnings', () => {
  assert.match(formatStatus(health, { prState: 'MERGED' }).text, /✓merged/);
  assert.match(formatStatus(health, { prState: 'CLOSED' }).text, /✗closed/);
  assert.equal(formatStatus(health, {}).level, 'warn');
  assert.equal(formatStatus({ ...health, deployed: null }).level, 'warn');
  assert.equal(formatStatus({ ...health, deployed: { ...health.deployed, commit: 'bad' } }).level, 'warn');
  const main = { ...health, deployed: { ...health.deployed, pr: undefined, branch: 'main', local: true } };
  assert.match(formatStatus(main, { head: commit }).text, /main local/);
  assert.equal(formatStatus(main, { head: commit }).level, 'ok');
});
test('probe escapes markdown metadata and derives the LAN URL without exposing SSH credentials', () => {
  assert.equal(statusUrl({ LAN_DEPLOY_SERVER: 'ssh://authoring@host.localdomain:2222' }, {}), 'http://host.localdomain:8000');
  assert.equal(statusUrl({}, { TERMINOLOGY_STATUS_URL: 'http://custom:8000/' }), 'http://custom:8000');
  assert.throws(() => statusUrl({}, { TERMINOLOGY_STATUS_URL: 'http://user:secret@host/' }));
  const status = formatStatus({ ...health, deployed: { ...health.deployed, branch: 'feature/[unsafe](link)' } }, { prState: 'OPEN', head: commit });
  assert.match(status.tooltip, /\\\[unsafe\\\]/);
});
