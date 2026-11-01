import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Store } from './store.js';
import { DomainError, type TermView } from './model.js';
import { conceptGraph, graphEdges, graphTypes } from './graph.js';
import { exportSkos } from './skos.js';

const at = z.number().int().nonnegative().optional().describe('Changelog version. Omit for current; reuse a returned version to pin subsequent reads.');
const ref = z.string().min(1).max(2000).describe('Stable term ID or exact alias (including scheme:path). Labels are searched with search_terms.');
const scheme = z.string().min(1).max(200).optional();
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

async function run(work: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await work() as Record<string, unknown>;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new DomainError(413, 'Result exceeds 1 MiB. Narrow the selection or use a smaller page; use the REST SKOS export for large schemes.');
    return { content: [{ type: 'text', text }], structuredContent: value };
  } catch (error) {
    if (!(error instanceof DomainError)) console.error('MCP tool failed:', error);
    return { isError: true, content: [{ type: 'text', text: error instanceof DomainError ? error.message : 'An unexpected error occurred. See the server log.' }] };
  }
}

/** Each HTTP request owns a server/transport; every tool captures one changelog version. */
export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: 'terminology-mcp', version: '0.1.0' }, { instructions:
    'Read the master terminology vocabulary. Start with list_schemes or search_terms, then use stable IDs for lookup, graphs and concept sets. '
    + 'All tools are read-only. Results carry a changelog version; pass at to keep multi-call reads consistent. '
    + 'Broader/narrower form an acyclic hierarchy; related/opposite are symmetric network edges and do not imply subsumption. '
    + 'Retired terms retain their IDs, aliases and replacements. Tree paths are aliases; graph/poly terms have no single path. '
    + 'Page through search/list/expansion results using nextOffset, retaining version. Editing and import application use the web editor.' });
  const version = (n?: number) => { const v = n ?? store.version; store.schemes(v); return v; };
  const requireScheme = (id: string | undefined, v: number) => {
    if (id && !store.schemes(v).some(s => s.id === id)) throw new DomainError(404, 'Scheme not found at this version.');
  };
  const slice = <T>(items: T[], offset: number, limit: number) => ({ total: items.length,
    offset, nextOffset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });

  server.registerTool('list_schemes', { description: 'List vocabulary schemes and their tree/poly/graph structure.',
    inputSchema: z.object({ at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at); return { version: v, ...slice(store.schemes(v), args.offset, args.limit) };
  }));
  server.registerTool('search_terms', { description: 'Case-insensitive substring search across labels, alternative labels, notations, aliases and source IRIs. Empty query browses terms. Defaults to active and provisional terms; status=all includes retired terms. Set filters use expanded membership.',
    inputSchema: z.object({ query: z.string().max(2000).default(''), scheme, set: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'provisional', 'retired', 'all']).optional(), at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at); requireScheme(args.scheme, v);
    let terms = store.terms(args.scheme, v);
    if (args.set) {
      const expanded = store.expandSet(args.set, v);
      if (args.scheme && expanded.set.scheme !== args.scheme) throw new DomainError(422, 'Set belongs to a different scheme.');
      const ids = new Set(expanded.terms.map(t => t.id)); terms = terms.filter(t => ids.has(t.id));
    }
    const query = normalize(args.query.trim());
    terms = terms.filter(t => (args.status === 'all' || (args.status ? t.status === args.status : t.status !== 'retired'))
      && [t.label, ...t.altLabels, ...t.notations.map(n => n.value), ...t.aliases, t.sourceUri ?? ''].some(value => normalize(value).includes(query)));
    return { version: v, ...slice(terms, args.offset, args.limit) };
  }));
  server.registerTool('get_term', { description: 'Resolve an ID or exact alias, including retired terms, replacements and all incoming/outgoing typed connections.',
    inputSchema: z.object({ ref, at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), term = store.lookup(args.ref, v);
    return { version: v, term, connections: graphEdges(store.terms(undefined, v)).filter(edge => edge.from === term.id)
      .map(edge => ({ type: edge.type, target: edge.to })) };
  }));
  server.registerTool('get_graph', { description: 'Read active concept nodes and typed edges, optionally within a scheme/set or around a term. Depth (0–5) applies only with around. All four edge types are included unless types is supplied. Results over 200 nodes or 1000 directed edges require a narrower selection; nothing is silently dropped.',
    inputSchema: z.object({ scheme, set: z.string().min(1).max(200).optional(), around: ref.optional(),
      depth: z.number().int().min(0).max(5).default(1), types: z.array(z.enum(graphTypes)).min(1).max(4).optional(), at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), graph = conceptGraph(store, { ...args, at: v });
    if (graph.concepts.length > 200 || graph.relations.length > 1000)
      throw new DomainError(413, 'Graph exceeds 200 nodes or 1000 directed edges. Narrow with scheme, set, around, depth or types.');
    return graph;
  }));
  server.registerTool('list_sets', { description: 'List concept collection definitions (explicit, ordered, nested or recipe) in a scheme or the workspace.',
    inputSchema: z.object({ scheme, at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at); requireScheme(args.scheme, v);
    return { version: v, ...slice(store.sets(args.scheme, v), args.offset, args.limit) };
  }));
  server.registerTool('get_set', { description: 'Get a collection definition by stable set ID at a version. Use expand_set for its calculated terms.',
    inputSchema: z.object({ id: z.string().min(1).max(200), at }).strict(), annotations }, args => run(() => {
    const v = version(args.at); return { version: v, set: store.conceptSet(args.id, v) };
  }));
  server.registerTool('expand_set', { description: 'Expand explicit/nested/recipe membership at a version. Page order preserves ordered collections. Includes diagnostics for retired references.',
    inputSchema: z.object({ id: z.string().min(1).max(200), at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at), expanded = store.expandSet(args.id, v);
    const { terms, ...metadata } = expanded;
    return { ...metadata, version: v, ...slice(terms, args.offset, args.limit) };
  }));
  server.registerTool('get_term_collections', { description: 'List same-scheme collections with direct, inherited and recipe membership flags for a term. Included=false means the term is outside that collection.',
    inputSchema: z.object({ ref, at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at), result = store.termCollections(args.ref, v);
    return { version: v, ...slice(result.collections, args.offset, args.limit) };
  }));
  server.registerTool('validate_term', { description: 'Check whether an ID/alias exists, is not retired and (optionally) belongs to an expanded collection. Provisional terms count as valid; status is returned. Unknown references return valid=false; unknown sets/versions are errors.',
    inputSchema: z.object({ ref, set: z.string().min(1).max(200).optional(), at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), expanded = args.set ? store.expandSet(args.set, v) : undefined;
    let term: TermView;
    try { term = store.lookup(args.ref, v); }
    catch (error) { if (error instanceof DomainError && error.status === 404) return { version: v, valid: false, reason: 'unknown-term' }; throw error; }
    const member = expanded ? expanded.terms.some(t => t.id === term.id) : null;
    return { version: v, id: term.id, status: term.status, replacedBy: term.replacedBy, member,
      valid: term.status !== 'retired' && member !== false,
      reason: term.status === 'retired' ? 'retired' : member === false ? 'outside-set' : null };
  }));
  server.registerTool('subsumes', { description: 'Compare two terms using only transitive broader links (all parents in poly/graph schemes). Returns equivalent, subsumes (a ancestor of b), subsumed-by, or not-subsumed. Associative and mapping edges are excluded; retired terms can be compared.',
    inputSchema: z.object({ a: ref, b: ref, at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), a = store.lookup(args.a, v), b = store.lookup(args.b, v);
    const terms = new Map(store.terms(undefined, v).map(t => [t.id, t]));
    const ancestor = (parent: string, child: string) => {
      const seen = new Set<string>(), pending = [...terms.get(child)!.broader];
      while (pending.length) { const id = pending.pop()!; if (id === parent) return true;
        if (!seen.has(id)) { seen.add(id); pending.push(...terms.get(id)!.broader); } }
      return false;
    };
    return { version: v, a: a.id, b: b.id, relationship: a.id === b.id ? 'equivalent'
      : ancestor(a.id, b.id) ? 'subsumes' : ancestor(b.id, a.id) ? 'subsumed-by' : 'not-subsumed' };
  }));
  server.registerTool('get_changes', { description: 'Page through change summaries after since and through at (inclusive). Set includeSnapshots=true for full before/after bodies (subject to output limit). Reuse version as at and nextSince as since for a consistent catch-up. Optional term is a stable term ID; optional scheme keeps changes touching that scheme. A null nextSince means this snapshot is complete; save version as your cursor.',
    inputSchema: z.object({ since: z.number().int().nonnegative().default(0), term: z.string().min(1).max(200).optional(),
      scheme: z.string().min(1).max(60).optional(), includeSnapshots: z.boolean().default(false), at, limit: page.limit }).strict(), annotations }, args => run(() => {
    const v = version(args.at);
    if (args.since > v) throw new DomainError(400, 'since cannot exceed the selected version.');
    const changes = store.changes(args.since, args.term, args.scheme).filter(change => change.n <= v), selected = changes.slice(0, args.limit);
    const items = args.includeSnapshots ? selected : selected.map(change => ({
      n: change.n, kind: change.kind, terms: change.terms, breaking: change.breaking, author: change.author, reason: change.reason, at: change.at,
      subject: { id: change.after.id, label: change.after.label },
      sets: [...new Set([...change.beforeSets ?? [], ...change.afterSets ?? [], change.before, change.after]
        .filter(item => item?.id.startsWith('s_')).map(item => item!.id))],
    }));
    const more = changes.length > selected.length;
    return { log: store.logId, version: v, includeSnapshots: args.includeSnapshots, items,
      nextSince: more ? selected.at(-1)!.n : null, through: more ? selected.at(-1)!.n : v };
  }));
  server.registerTool('export_skos', { description: 'Export a scheme and its collections as SKOS Turtle at a version, including notations, mappings and collection definitions. Limited to 1 MiB; use the REST export for larger vocabularies.',
    inputSchema: z.object({ scheme: z.string().min(1).max(200), at }).strict(), annotations }, args => run(async () => {
    const v = version(args.at); return { version: v, mediaType: 'text/turtle', data: await exportSkos(store, args.scheme, v) };
  }));
  return server;
}
