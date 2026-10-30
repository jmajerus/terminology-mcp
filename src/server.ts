import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store } from './store.js';
import { DomainError } from './model.js';
import { exportSkos, importRequestSchema, planSkos, rdfSchemes } from './skos.js';
import { discoverSchemes, fetchScheme } from './sparql.js';
import { z } from 'zod';

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
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createApp(store: Store, options: { demo?: boolean } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new DomainError(403, 'The local editor must be accessed through localhost.');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers.origin && req.headers.origin !== url.origin)
          throw new DomainError(403, 'Cross-origin writes are not allowed.');
        if (req.headers['sec-fetch-site'] === 'cross-site')
          throw new DomainError(403, 'Cross-site writes are not allowed.');
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
          const input = z.object({ format: z.enum(['turtle', 'sparql']), data: z.string().optional(),
            endpoint: z.string().optional(), graph: z.string().optional() }).strict().parse(await body(req, 6 * 1024 * 1024));
          const schemes = input.format === 'turtle' ? rdfSchemes(input.data ?? '')
            : await discoverSchemes(input.endpoint ?? '', input.graph);
          json(res, 200, { schemes }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/imports/preview') {
          const input = importRequestSchema.parse(await body(req, 6 * 1024 * 1024));
          const data = input.format === 'turtle' ? input.data ?? '' : await fetchScheme(input.endpoint ?? '', input.sourceScheme, input.graph);
          const { plan, warnings } = planSkos(store, data, input);
          const result = store.preview(() => store.importScheme(plan, store.version));
          json(res, 200, { plan, warnings, expectedVersion: store.version, count: result.count,
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
          json(res, 200, { version: at ?? store.version, head: store.version, demo: !!options.demo, schemes: store.schemes(at), terms: store.terms(undefined, at) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/changes') {
          json(res, 200, { version: store.version,
            changes: store.changes(numberParam(url, 'since') ?? 0, url.searchParams.get('term') ?? undefined) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/schemes') {
          json(res, 201, { scheme: store.addScheme(await body(req)), version: store.version });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/terms') {
          json(res, 201, { term: store.addTerm(await body(req)), version: store.version });
          return;
        }
        const match = url.pathname.match(/^\/api\/terms\/([^/]+)$/);
        if (match && req.method === 'GET') {
          json(res, 200, { term: store.lookup(decodeURIComponent(match[1]), at), version: at ?? store.version, head: store.version });
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
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
      };
      const asset = assets[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(req.method ?? '')) throw new DomainError(404, 'Page not found.');
      const data = await readFile(fileURLToPath(new URL(`../public/${asset[0]}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error instanceof ZodError) {
        json(res, 422, { error: error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ') });
      } else if (error instanceof DomainError) {
        json(res, error.status, { error: error.message });
      } else {
        console.error(error);
        json(res, 500, { error: 'An unexpected error occurred. See the server log.' });
      }
    }
  });
}
