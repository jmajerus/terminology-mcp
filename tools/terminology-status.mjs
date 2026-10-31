#!/usr/bin/env node
// Status Probe JSON output. Reads GitHub refs; never fetches or switches branches.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const icon = '$(symbol-namespace)';
const escapeMarkdown = value => String(value ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
const tooltip = (rows, note) => '**Terminology server**\n\n| | |\n|---|---|\n' +
  rows.map(([key, value]) => `| ${escapeMarkdown(key)} | ${escapeMarkdown(value)} |`).join('\n') + (note ? '\n\n' + note : '');

function command(name, args) {
  try { return execFileSync(name, args, { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
export function statusUrl(values = {}, environment = process.env) {
  if (environment.TERMINOLOGY_STATUS_URL || values.TERMINOLOGY_STATUS_URL) {
    const url = new URL(environment.TERMINOLOGY_STATUS_URL || values.TERMINOLOGY_STATUS_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid status URL configuration.');
    return url.href.replace(/\/$/, '');
  }
  const address = environment.LAN_DEPLOY_SERVER || values.LAN_DEPLOY_SERVER || 'terminology-mcp.localdomain';
  const url = new URL(address.includes('://') ? address : 'ssh://' + address);
  return `http://${url.hostname}:3210`;
}

export function formatStatus(health, remote = {}, base = 'http://terminology-mcp.localdomain:3210') {
  const rows = [['Server', base], ['Version', health.version], ['Schemes', health.schemes], ['Terms', health.terms]];
  const deployed = health.deployed;
  if (!deployed || !/^[a-f0-9]{40}$/.test(deployed.commit) || typeof deployed.branch !== 'string' ||
      (deployed.pr !== undefined && (!Number.isSafeInteger(deployed.pr) || deployed.pr < 1)))
    return { text: `${icon} ?`, level: 'warn', open: base,
      tooltip: tooltip(rows, 'No valid deployment record. Deploy once with Deploy Terminology to record the running source.') };
  const marks = [], notes = [];
  if (deployed.pr && remote.prState === 'MERGED') { marks.push('✓merged'); notes.push('PR merged. Use Deploy Terminology → Switch to main.'); }
  else if (deployed.pr && remote.prState === 'CLOSED') { marks.push('✗closed'); notes.push('PR closed. Use Deploy Terminology → Switch to main.'); }
  else {
    if (deployed.pr && remote.prState !== 'OPEN') notes.push('PR state unavailable from GitHub.');
    if (!remote.head) notes.push('Remote branch/PR head is unavailable.');
    else if (remote.head !== deployed.commit) {
      if (remote.comparison?.status === 'ahead' && Number.isSafeInteger(remote.comparison.ahead_by) && remote.comparison.ahead_by > 0) {
        marks.push(`↓${remote.comparison.ahead_by}`); notes.push('Redeploy current branch to catch up.');
      } else notes.push('The remote head differs; lag is unknown or history has diverged.');
    }
  }
  if (deployed.local) marks.push('local');
  const branch = deployed.branch.slice(deployed.branch.lastIndexOf('/') + 1);
  const label = deployed.pr ? `#${deployed.pr}` : branch.length > 16 ? branch.slice(0, 15) + '…' : branch;
  rows.unshift(['Running', deployed.branch + (deployed.pr ? ` (PR #${deployed.pr})` : '')],
    ['Commit', deployed.commit.slice(0, 7)], ['Deployed', deployed.at ?? 'unknown']);
  rows.push(['Checked', new Date().toLocaleTimeString()]);
  return { text: [`${icon} ${label}`, ...marks].join(' '), open: base,
    level: notes.length || deployed.branch === 'HEAD' ? 'warn' : 'ok', tooltip: tooltip(rows, notes.join(' ')) };
}

export async function probe() {
  let base = 'http://terminology-mcp.localdomain:3210';
  try {
    const values = existsSync(join(root, '.env')) ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : {};
    base = statusUrl(values);
    const response = await fetch(base + '/health', { signal: AbortSignal.timeout(8000) });
    let health;
    if (response.status === 404) {
      // PRs predating /health can still be deployed and identified over SSH.
      const legacy = await fetch(base + '/api/state', { signal: AbortSignal.timeout(8000) });
      if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
      const state = await legacy.json();
      let deployed = null;
      try { deployed = JSON.parse(command('python3', ['tools/deploy.py', '--status']) ?? 'null'); } catch {}
      health = { ok: true, version: state.version, schemes: state.schemes?.length, terms: state.terms?.length, deployed };
    } else {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      health = await response.json();
      if (!health.ok) throw new Error('Server reported unhealthy.');
    }
    const deployed = health.deployed;
    if (!deployed?.commit || !/^[a-f0-9]{40}$/.test(deployed.commit) || typeof deployed.branch !== 'string') return formatStatus(health, {}, base);
    const remote = {};
    if (Number.isSafeInteger(deployed.pr) && deployed.pr > 0)
      remote.prState = command('gh', ['pr', 'view', String(deployed.pr), '--json', 'state', '--jq', '.state']);
    if (!['CLOSED', 'MERGED'].includes(remote.prState)) {
      const ref = deployed.pr ? `refs/pull/${deployed.pr}/head` : `refs/heads/${deployed.branch}`;
      remote.head = command('git', ['ls-remote', 'origin', ref])?.split(/\s/)[0] || null;
      if (remote.head && /^[a-f0-9]{40}$/.test(remote.head) && remote.head !== deployed.commit) {
        try { remote.comparison = JSON.parse(command('gh', ['api', `repos/{owner}/{repo}/compare/${deployed.commit}...${remote.head}`, '--jq', '{status:.status,ahead_by:.ahead_by}']) ?? 'null'); } catch {}
      }
    }
    return formatStatus(health, remote, base);
  } catch {
    return { text: `${icon} ?`, level: 'error', open: base,
      tooltip: tooltip([['Server', base]], 'Server unreachable/unhealthy, or status configuration invalid.') };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(JSON.stringify(await probe()) + '\n');
