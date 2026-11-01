import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { DomainError } from './model.js';
import { exportSkos, importRequestSchema, planSkos, rdfSchemes } from './skos.js';
import { discoverSchemes, fetchScheme } from './sparql.js';
import { z } from 'zod';
import { allowedOrigins, requestOrigin } from './http-config.js';
import { deploymentRecord } from './deployment.js';
import { graphSchemes, planGraph } from './graph-import.js';
import { conceptGraph, graphEdges, graphTypes } from './graph.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp.js';
import { AccessError, authorizeRequest, proxiedRequest, requestAccessConfig, type RequestAccessConfig } from './access.js';
import type { JWTVerifyGetKey } from 'jose';

async function body(req: IncomingMessage, limit = 128 * 1024): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new DomainError(415, 'Send application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new DomainError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError(400, 'Invalid JSON.'); }
}
function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new DomainError(400, `${name} must be a nonnegative integer.`);
  return Number(raw);
}
// Responses to anonymous visitors, whose JSON hides email addresses (change authors and proposers).
const redacted = new WeakSet<ServerResponse>();
const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(redacted.has(res) ? JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.replace(EMAIL, 'an editor') : item)
    : JSON.stringify(value));
}

export function createApp(store: Store, options: { demo?: boolean; origins?: string[]; deploymentFile?: string;
  access?: RequestAccessConfig; accessKeys?: JWTVerifyGetKey; editUrl?: string } = {}) {
  const origins = allowedOrigins(options.origins);
  const access = options.access ?? requestAccessConfig({}, ['terminology-mcp', 'terminology-mcp.localdomain']);
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Cloudflare only routes the hostnames configured there, so a proxied request is served under its own (HTTPS)
      // hostname; the allowlist guards direct LAN requests against DNS rebinding.
      const origin = requestOrigin(req.headers.host, origins) ?? (proxiedRequest(req) ? requestOrigin(req.headers.host, new Map(), 'https:') : null);
      if (!origin) throw new DomainError(403, 'This host is not configured for the editor.');
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new DomainError(403, 'Request URL does not match its Host header.');
      const identity = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      // Over Access the verified identity names the author; LAN callers name themselves.
      const caller = identity.via === 'access' ? identity.email ?? identity.subject : undefined;
      const visitor = identity.via === 'public';
      if (visitor) redacted.add(res);
      // Visitors edit nowhere here; the owner edits on the hostname named by editUrl.
      const edit = visitor && options.editUrl ? { edit: options.editUrl } : {};
      if (url.pathname === '/api/viewer' && req.method === 'GET') {
        json(res, 200, { canEdit: !visitor, via: identity.via, ...(caller ? { name: caller } : {}), ...edit,
          ...(identity.via === 'access' ? { signOut: '/cdn-cgi/access/logout' } : {}) });
        return;
      }
      if (visitor && (!['GET', 'HEAD'].includes(req.method ?? '') || url.pathname === '/mcp' || url.pathname.startsWith('/api/subscribers')))
        throw new DomainError(401, 'This is a read-only view.', edit);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers.origin && req.headers.origin !== origin)
          throw new DomainError(403, 'Cross-origin writes are not allowed.');
        if (req.headers['sec-fetch-site'] === 'cross-site')
          throw new DomainError(403, 'Cross-site writes are not allowed.');
      }
      if (url.pathname === '/mcp') {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          json(res, 405, { error: 'MCP uses stateless Streamable HTTP POST requests.' }); return;
        }
        const input = await body(req);
        const mcp = createMcpServer(store, { caller });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => { void mcp.close().catch(error => console.error('MCP cleanup failed:', error)); });
        try { await mcp.connect(transport); await transport.handleRequest(req, res, input); }
        catch (error) { await mcp.close(); throw error; }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        const count = (table: 'schemes' | 'terms') => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        json(res, 200, { ok: true, log: store.logId, version: store.version, schemes: count('schemes'), terms: count('terms'),
          deployed: await deploymentRecord(options.deploymentFile) });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const at = numberParam(url, 'at');
        const exportMatch = url.pathname.match(/^\/api\/schemes\/([^/]+)\/skos$/);
        if (exportMatch && req.method === 'GET') {
          const data = await exportSkos(store, decodeURIComponent(exportMatch[1]), at);
          res.writeHead(200, { 'Content-Type': 'text/turtle; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="taxonomy.ttl"' });
          res.end(data); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/imports/schemes') {
          const input = z.object({ format: z.enum(['turtle', 'sparql', 'graph-json']), data: z.string().optional(),
            endpoint: z.string().optional(), graph: z.string().optional() }).strict().parse(await body(req, 6 * 1024 * 1024));
          const schemes = input.format === 'graph-json' ? graphSchemes(input.data ?? '') : input.format === 'turtle' ? rdfSchemes(input.data ?? '')
            : await discoverSchemes(input.endpoint ?? '', input.graph);
          json(res, 200, { schemes }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/imports/preview') {
          const input = importRequestSchema.parse(await body(req, 6 * 1024 * 1024));
          const data = input.format !== 'sparql' ? input.data ?? '' : await fetchScheme(input.endpoint ?? '', input.sourceScheme, input.graph);
          const { plan, warnings, analysis } = input.format === 'graph-json' ? planGraph(store, data, input) : planSkos(store, data, input);
          if (!analysis.compatible) {
            json(res, 200, { plan, warnings, analysis, expectedVersion: store.version, count: plan.terms.length, sets: plan.sets,
              terms: plan.terms.map(term => ({ label: term.label, broader: term.broader.length })) }); return;
          }
          const result = store.preview(() => store.importScheme(plan, store.version));
          json(res, 200, { plan, warnings, analysis, expectedVersion: store.version, count: result.count, sets: result.sets,
            terms: result.affected.map(change => ({ label: change.after.label, broader: change.after.broader.length })) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/imports/apply') {
          const input = z.object({ plan: z.unknown(), expectedVersion: z.number().int().nonnegative() }).strict()
            .parse(await body(req, 10 * 1024 * 1024));
          json(res, 201, store.importScheme(input.plan, input.expectedVersion)); return;
        }
        const operation = url.pathname.match(/^\/api\/terms\/([^/]+)\/operations\/(preview|apply)$/);
        if (operation && req.method === 'POST') {
          const input = await body(req);
          const run = () => store.operate(decodeURIComponent(operation[1]), input);
          json(res, 200, operation[2] === 'preview' ? store.preview(run) : run()); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') {
          const scheme = url.searchParams.get('scheme') ?? undefined, schemes = store.schemes(at).filter(item => !scheme || item.id === scheme);
          if (scheme && !schemes.length) throw new DomainError(404, 'Scheme not found at this version.');
          json(res, 200, { log: store.logId, version: at ?? store.version, head: store.version, demo: !!options.demo, schemes,
            terms: store.terms(scheme, at), sets: store.sets(scheme, at) });
          return;
        }
        const slugMatch = url.pathname.match(/^\/api\/schemes\/([^/]+)\/slugs\/([^/]+)$/);
        if (slugMatch && req.method === 'GET') {
          json(res, 200, store.slugLookup(decodeURIComponent(slugMatch[1]), decodeURIComponent(slugMatch[2]),
            { parent: url.searchParams.get('parent') ?? undefined, depth: numberParam(url, 'depth') }, at)); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/graph') {
          json(res, 200, conceptGraph(store, { at, scheme: url.searchParams.get('scheme') ?? undefined,
            set: url.searchParams.get('set') ?? undefined, around: url.searchParams.get('around') ?? undefined,
            depth: numberParam(url, 'depth'), types: url.searchParams.has('types') ? z.array(z.enum(graphTypes)).parse(url.searchParams.get('types')!.split(',')) : undefined })); return;
        }
        if (['POST', 'DELETE'].includes(req.method ?? '') && url.pathname === '/api/relations') {
          const input = z.object({ from: z.string(), to: z.string(), type: z.enum(['related', 'opposite']),
            expectedVersion: z.number().int().nonnegative() }).strict().parse(await body(req));
          json(res, 200, store.setRelation(input.from, input.to, input.type, req.method === 'POST', input.expectedVersion)); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/changes') {
          json(res, 200, { log: store.logId, version: store.version, changes: store.changes(numberParam(url, 'since') ?? 0,
            url.searchParams.get('term') ?? undefined, url.searchParams.get('scheme') ?? undefined) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/schemes') {
          json(res, 201, { scheme: store.addScheme(await body(req)), version: store.version });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/sets') {
          json(res, 200, { sets: store.sets(url.searchParams.get('scheme') ?? undefined, at), version: at ?? store.version }); return;
        }
        const setMatch = url.pathname.match(/^\/api\/sets\/([^/]+)(?:\/(expand|preview|graph))?$/);
        if (setMatch && setMatch[2] !== 'preview' && req.method === 'GET') {
          const id = decodeURIComponent(setMatch[1]);
          if (setMatch[2] === 'graph') { json(res, 200, { ...conceptGraph(store, { set: id, at }), set: store.conceptSet(id, at) }); return; }
          json(res, 200, setMatch[2] === 'expand' ? store.expandSet(id, at) : { set: store.conceptSet(id, at), version: at ?? store.version }); return;
        }
        if ((url.pathname === '/api/sets' || setMatch) && ['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
          if (setMatch?.[2] === 'expand' || setMatch?.[2] === 'graph') throw new DomainError(404, 'API route not found.');
          const input = z.object({ set: z.unknown().optional(), expectedVersion: z.number().int().nonnegative() }).strict().parse(await body(req, 2 * 1024 * 1024));
          const newPreview = url.pathname === '/api/sets/preview';
          const id = setMatch && !newPreview ? decodeURIComponent(setMatch[1]) : undefined;
          const isPreview = newPreview || setMatch?.[2] === 'preview';
          if ((isPreview && req.method !== 'POST') || (!id && !isPreview && req.method !== 'POST') ||
              (id && !isPreview && !['PATCH', 'DELETE'].includes(req.method ?? '')))
            throw new DomainError(404, 'API route not found.');
          const run = () => {
            if (req.method === 'DELETE') {
              if (!id) throw new DomainError(404, 'Set ID required.');
              return store.deleteSet(id, input.expectedVersion);
            }
            const set = store.saveSet(input.set, input.expectedVersion, id);
            return { ...store.expandSet(set.id), version: store.version };
          };
          json(res, 200, isPreview ? store.preview(run) : run()); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/proposals') {
          const result = store.propose(await body(req), caller);
          json(res, result.replayed ? 200 : 201, result); return;
        }
        const schemeMatch = url.pathname.match(/^\/api\/schemes\/([^/]+)$/);
        if (schemeMatch && req.method === 'PATCH') {
          json(res, 200, { scheme: store.updateScheme(decodeURIComponent(schemeMatch[1]), await body(req)), version: store.version }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/subscribers') {
          json(res, 200, { log: store.logId, version: store.version, subscribers: store.subscribers() }); return;
        }
        const subscriberMatch = url.pathname.match(/^\/api\/subscribers\/([^/]+)(\/progress)?$/);
        if (subscriberMatch && req.method === 'GET' && !subscriberMatch[2]) {
          json(res, 200, store.subscriber(decodeURIComponent(subscriberMatch[1]))); return;
        }
        if (subscriberMatch && req.method === 'POST' && subscriberMatch[2]) {
          json(res, 200, store.reportProgress(decodeURIComponent(subscriberMatch[1]), await body(req))); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/terms') {
          json(res, 201, { term: store.addTerm(await body(req)), version: store.version });
          return;
        }
        const memberships = url.pathname.match(/^\/api\/terms\/([^/]+)\/collections$/);
        if (memberships && req.method === 'GET') { json(res, 200, store.termCollections(decodeURIComponent(memberships[1]), at)); return; }
        const match = url.pathname.match(/^\/api\/terms\/([^/]+)$/);
        if (match && req.method === 'GET') {
          const term = store.lookup(decodeURIComponent(match[1]), at);
          json(res, 200, { term, connections: graphEdges(store.terms(undefined, at)).filter(edge => edge.from === term.id)
            .map(edge => ({ type: edge.type, target: edge.to })), version: at ?? store.version, head: store.version });
          return;
        }
        if (match && req.method === 'PATCH') {
          json(res, 200, { term: store.editTerm(decodeURIComponent(match[1]), await body(req)), version: store.version });
          return;
        }
        throw new DomainError(404, 'API route not found.');
      }
      const assets: Record<string, [string, string]> = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/admin': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/sets': ['sets.html', 'text/html; charset=utf-8'],
        '/sets.js': ['sets.js', 'text/javascript; charset=utf-8'],
        '/graph': ['graph.html', 'text/html; charset=utf-8'],
        '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/viewer.js': ['viewer.js', 'text/javascript; charset=utf-8'],
        // d3-force and its dependencies, served from node_modules because the CSP allows only this origin's scripts.
        ...Object.fromEntries(['d3-dispatch', 'd3-quadtree', 'd3-timer', 'd3-force'].map(name =>
          [`/vendor/${name}.js`, [`../node_modules/${name}/dist/${name}.min.js`, 'text/javascript; charset=utf-8']])),
      };
      const asset = assets[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(req.method ?? '')) throw new DomainError(404, 'Page not found.');
      const data = await readFile(fileURLToPath(new URL(`../public/${asset[0]}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof AccessError) {
        json(res, error.status, { error: error.message });
      } else if (error instanceof ZodError) {
        json(res, 422, { error: error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ') });
      } else if (error instanceof DomainError) {
        json(res, error.status, { error: error.message, ...error.details });
      } else {
        console.error(error);
        json(res, 500, { error: 'An unexpected error occurred. See the server log.' });
      }
    }
  });
}
