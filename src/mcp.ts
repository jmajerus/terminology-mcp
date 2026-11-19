import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Store } from './store.js';
import { DomainError, termIri, type TermView } from './model.js';
import { conceptGraph, graphEdges, graphTypes } from './graph.js';
import { exportSkos } from './skos.js';
import { notice, type TermKeys } from './keys.js';
import type { WordnetLookup, WordnetSearch } from './wordnet.js';
import type { CcLookup, CcSearch } from './concept-clusters.js';

const at = z.number().int().nonnegative().optional().describe('Changelog version. Omit for current; reuse a returned version to pin subsequent reads.');
const ref = z.string().min(1).max(2000).describe('Stable term ID, exact alias (including scheme:path), or scheme:slug such as "human-work:conflict" (former slugs too; scheme:parent-slug/slug where a slug repeats). Labels are searched with search_terms.');
const scheme = z.string().min(1).max(200).optional();
const page = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) };
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
/** A term with its concept key (scheme:slug), the form to reuse in later calls. */
const keyed = (keys: TermKeys) => <T extends TermView>(term: T) => ({ ...term, key: keys.key(term) });
/**
 * What each term maps as narrower: its narrowMatch targets, and the terms whose broadMatch points back at it. A target
 * that is a term here (by any IRI it answers to) is named; any other stays an IRI. Retired terms are left out.
 */
function narrowerMatches(terms: TermView[], keys: TermKeys) {
  const byIri = new Map<string, TermView>();
  for (const term of terms) for (const iri of [termIri(term), `urn:terminology-mcp:term:${term.id}`, term.sourceUri ?? '', ...term.aliases])
    if (iri && !byIri.has(iri)) byIri.set(iri, term);
  const name = (term: TermView) => ({ iri: termIri(term), key: keys.key(term), id: term.id, label: term.label, scheme: term.scheme });
  const back = new Map<string, TermView[]>();
  for (const term of terms) for (const link of term.links) if (link.match === 'broadMatch') {
    const hub = byIri.get(link.uri);
    if (hub && hub.id !== term.id) back.set(hub.id, [...back.get(hub.id) ?? [], term]);
  }
  return (hub: TermView) => {
    const out = new Map<string, { iri: string; key?: string; id?: string; label?: string; scheme?: string }>();
    for (const link of hub.links) if (link.match === 'narrowMatch') {
      const term = byIri.get(link.uri);
      if (!term) out.set(link.uri, { iri: link.uri });
      else if (term.status !== 'retired' && term.id !== hub.id) out.set(term.id, name(term));
    }
    for (const term of back.get(hub.id) ?? []) if (term.status !== 'retired') out.set(term.id, name(term));
    return [...out.values()].sort((a, b) => (a.label ?? a.iri).localeCompare(b.label ?? b.iri));
  };
}
/** Adds notices for references that resolved by an alias over a scheme:slug, or by a former slug. */
const noted = <T extends object>(value: T, notices: ({ ref: string; message: string } | undefined)[]) => {
  const found = notices.filter(item => item !== undefined);
  return found.length ? { ...value, notices: found } : value;
};

async function run(work: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await work() as Record<string, unknown>;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new DomainError(413, 'Result exceeds 1 MiB. Narrow the selection or use a smaller page; use the REST SKOS export for large schemes.');
    return { content: [{ type: 'text', text }], structuredContent: value };
  } catch (error) {
    if (!(error instanceof DomainError)) console.error('MCP tool failed:', error);
    const text = !(error instanceof DomainError) ? 'An unexpected error occurred. See the server log.'
      : error.details ? `${error.message}\n${JSON.stringify(error.details)}` : error.message;
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

/** Each HTTP request owns a server/transport; every tool captures one changelog version. */
export function createMcpServer(store: Store, options: { caller?: string; wordnet?: WordnetLookup; wordnetSearch?: WordnetSearch;
  conceptClusters?: CcLookup; conceptClustersSearch?: CcSearch } = {}): McpServer {
  const server = new McpServer({ name: 'terminology-mcp', version: '0.1.0' }, { instructions:
    'Read the master terminology vocabulary. Start with list_schemes or search_terms, then use stable IDs or concept keys (scheme:slug, e.g. human-work:conflict) for lookup, graphs and concept sets. '
    + 'A term reference is tried as a stable ID, then an exact alias, then scheme:slug; each term carries its key. '
    + 'Every tool except propose_term is read-only; propose_term adds a provisional term for the owner to review. Results carry a changelog version; pass at to keep multi-call reads consistent. '
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
  server.registerTool('search_terms', { description: 'Case-insensitive substring search across labels, alternative labels, notations, aliases and source IRIs. Empty query browses terms. Each hit carries its iri and key (scheme:slug). Defaults to active and provisional terms; status=all includes retired terms. Set filters use expanded membership. Before propose_term, search a reference vocabulary (scheme loc-classification, or excludeScheme set to the target scheme) for a source. linksTo finds the terms with an external reference (exactMatch, closeMatch…) to that IRI or under it: a Concept Clusters puzzle IRI also finds links to its clusters, terms and bridges. narrower: true adds to each hit its narrowerMatches, the terms it maps as narrower (its narrowMatch links, and terms whose broadMatch points to it): an index term such as concept-index:depravity leads to specific terms in other schemes whose labels never use the word, so search it without a scheme filter.',
    inputSchema: z.object({ query: z.string().max(2000).default(''), scheme, excludeScheme: z.string().min(1).max(200).optional(), set: z.string().min(1).max(200).optional(),
      linksTo: z.string().min(1).max(2000).optional().describe('An external IRI, e.g. urn:concept-clusters:puzzle:on-killing. Matches links to the IRI itself and to IRIs under it (#fragment or /path).'),
      narrower: z.boolean().optional().describe('Add narrowerMatches to each hit: what it maps as narrower, resolved to terms here (iri, key, label, scheme) or left as an external iri.'),
      status: z.enum(['active', 'provisional', 'retired', 'all']).optional(), at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at); requireScheme(args.scheme, v); requireScheme(args.excludeScheme, v);
    let terms = store.terms(args.scheme, v).filter(t => t.scheme !== args.excludeScheme);
    if (args.set) {
      const expanded = store.expandSet(args.set, v);
      if (args.scheme && expanded.set.scheme !== args.scheme) throw new DomainError(422, 'Set belongs to a different scheme.');
      const ids = new Set(expanded.terms.map(t => t.id)); terms = terms.filter(t => ids.has(t.id));
    }
    const query = normalize(args.query.trim()), linksTo = args.linksTo;
    if (linksTo) terms = terms.filter(t => t.links.some(link => link.uri === linksTo || (link.uri.startsWith(linksTo) && /^[#/]/.test(link.uri.slice(linksTo.length)))));
    terms = terms.filter(t => (args.status === 'all' || (args.status ? t.status === args.status : t.status !== 'retired'))
      && [t.label, ...t.altLabels, ...t.notations.map(n => n.value), ...t.aliases, t.sourceUri ?? ''].some(value => normalize(value).includes(query)));
    const found = slice(terms, args.offset, args.limit), keys = store.termKeys(v), key = keyed(keys);
    const narrower = args.narrower ? narrowerMatches(store.terms(undefined, v), keys) : undefined;
    return { version: v, ...found, items: found.items.map(t => ({ ...key(t), iri: termIri(t), ...(narrower ? { narrowerMatches: narrower(t) } : {}) })) };
  }));
  server.registerTool('get_term', { description: 'Resolve a stable ID, exact alias or scheme:slug (e.g. human-work:conflict), including retired terms, replacements and all incoming/outgoing typed connections. The term carries its key (scheme:slug) for reuse. A link to an Open English WordNet synset (https://en-word.net/id/…) carries wordnet: the synset\'s words, part of speech and definition, or found=false when WordNet has no such synset; it is absent when the WordNet server cannot be reached. A link to a Concept Clusters puzzle or one of its clusters, terms or bridges (urn:concept-clusters:puzzle:…) carries conceptClusters: the item\'s kind, label and fact or note, and the puzzle\'s title and public url, which an article can link to; found=false when the puzzle or item is no longer published.',
    inputSchema: z.object({ ref, at }).strict(), annotations }, args => run(async () => {
    const v = version(args.at), keys = store.termKeys(v), found = keys.resolve(args.ref), keyedTerm = keyed(keys)(found.term);
    const term = { ...keyedTerm, links: await Promise.all(keyedTerm.links.map(async link => {
      const [synset, item] = await Promise.all([options.wordnet?.(link.uri), options.conceptClusters?.(link.uri)]);
      if (synset) { const { uri: _uri, ...wordnet } = synset; return { ...link, wordnet }; }
      if (item) { const { uri: _uri, ...conceptClusters } = item; return { ...link, conceptClusters }; }
      return link;
    })) };
    return noted({ version: v, term, connections: graphEdges(store.terms(undefined, v)).filter(edge => edge.from === term.id)
      .map(edge => ({ type: edge.type, target: edge.to })) }, [notice(args.ref, found)]);
  }));
  server.registerTool('search_wordnet', { description: 'Find Open English WordNet synsets for a word or phrase (whole words, any case; e.g. "anger" or "see red"), to judge or suggest a WordNet closeMatch for a concept. Each result has the synset uri (https://en-word.net/id/…, the form links use), its words, part of speech and definition; nouns come first. Read-only: links are added in the web editor.',
    inputSchema: z.object({ word: z.string().trim().min(1).max(100) }).strict(),
    // It asks the WordNet server, outside this vocabulary.
    annotations: { ...annotations, openWorldHint: true } }, args => run(async () => {
    const results = await options.wordnetSearch?.(args.word);
    if (!results) throw new DomainError(503, 'The WordNet server is unavailable or lookups are turned off.');
    return { word: args.word, results };
  }));
  server.registerTool('search_concept_clusters', { description: 'Find Concept Clusters puzzle content whose label contains a word or phrase (any case, at least 2 characters; e.g. "dehumanization" or "cruelty"): clusters, the terms on puzzle boards, and bridges between clusters. Each result has its uri (urn:concept-clusters:puzzle:<id>#<item>, the form links use), kind, label, fact or note, a term\'s cluster, and the puzzle\'s title and public url. Use it to find a puzzle that gives a concept further context, then cite or link the puzzle url; prefer a cluster when one fits. Read-only: links are added in the web editor. search_terms with linksTo finds the terms already linked to a puzzle.',
    inputSchema: z.object({ text: z.string().trim().min(2).max(100) }).strict(),
    // It asks Concept Clusters' published graphs, outside this vocabulary.
    annotations: { ...annotations, openWorldHint: true } }, args => run(async () => {
    const results = await options.conceptClustersSearch?.(args.text);
    if (!results) throw new DomainError(503, 'The Concept Clusters graph server is unavailable or lookups are turned off.');
    return { text: args.text, results };
  }));
  server.registerTool('get_graph', { description: 'Read active concept nodes and typed edges, optionally within a scheme/set or around a term (stable ID, alias or scheme:slug). Each concept carries its key. Depth (0–5) applies only with around. All four edge types are included unless types is supplied. Results over 200 nodes or 1000 directed edges require a narrower selection; nothing is silently dropped.',
    inputSchema: z.object({ scheme, set: z.string().min(1).max(200).optional(), around: ref.optional(),
      depth: z.number().int().min(0).max(5).default(1), types: z.array(z.enum(graphTypes)).min(1).max(4).optional(), at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), keys = store.termKeys(v), centre = args.around === undefined ? undefined : keys.resolve(args.around);
    const graph = conceptGraph(store, { ...args, around: centre?.term.id, at: v });
    if (graph.concepts.length > 200 || graph.relations.length > 1000)
      throw new DomainError(413, 'Graph exceeds 200 nodes or 1000 directed edges. Narrow with scheme, set, around, depth or types.');
    return noted({ ...graph, concepts: graph.concepts.map(keyed(keys)) }, [centre && notice(args.around!, centre)]);
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
    const { terms, ...metadata } = expanded, found = slice(terms, args.offset, args.limit);
    return { ...metadata, version: v, ...found, items: found.items.map(keyed(store.termKeys(v))) };
  }));
  server.registerTool('get_term_collections', { description: 'List same-scheme collections with direct, inherited and recipe membership flags for a term (stable ID, alias or scheme:slug). Included=false means the term is outside that collection.',
    inputSchema: z.object({ ref, at, ...page }).strict(), annotations }, args => run(() => {
    const v = version(args.at), keys = store.termKeys(v), found = keys.resolve(args.ref), result = store.termCollections(found.term.id, v);
    return noted({ version: v, id: found.term.id, key: keys.key(found.term), ...slice(result.collections, args.offset, args.limit) }, [notice(args.ref, found)]);
  }));
  server.registerTool('validate_term', { description: 'Check whether an ID, alias or scheme:slug exists, is not retired and (optionally) belongs to an expanded collection. Provisional terms count as valid; status is returned. Unknown references return valid=false; unknown sets/versions and a slug naming several terms are errors. Returns the key (scheme:slug) of the term.',
    inputSchema: z.object({ ref, set: z.string().min(1).max(200).optional(), at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), expanded = args.set ? store.expandSet(args.set, v) : undefined;
    const keys = store.termKeys(v);
    let found: ReturnType<TermKeys['resolve']>;
    try { found = keys.resolve(args.ref); }
    catch (error) { if (error instanceof DomainError && error.status === 404) return { version: v, valid: false, reason: 'unknown-term' }; throw error; }
    const { term } = found, member = expanded ? expanded.terms.some(t => t.id === term.id) : null;
    return noted({ version: v, id: term.id, key: keys.key(term), status: term.status, replacedBy: term.replacedBy, member,
      valid: term.status !== 'retired' && member !== false,
      reason: term.status === 'retired' ? 'retired' : member === false ? 'outside-set' : null }, [notice(args.ref, found)]);
  }));
  server.registerTool('subsumes', { description: 'Compare two terms (stable ID, alias or scheme:slug) using only transitive broader links (all parents in poly/graph schemes). Returns equivalent, subsumes (a ancestor of b), subsumed-by, or not-subsumed. Associative and mapping edges are excluded; retired terms can be compared.',
    inputSchema: z.object({ a: ref, b: ref, at }).strict(), annotations }, args => run(() => {
    const v = version(args.at), keys = store.termKeys(v), foundA = keys.resolve(args.a), foundB = keys.resolve(args.b), a = foundA.term, b = foundB.term;
    const terms = new Map(store.terms(undefined, v).map(t => [t.id, t]));
    const ancestor = (parent: string, child: string) => {
      const seen = new Set<string>(), pending = [...terms.get(child)!.broader];
      while (pending.length) { const id = pending.pop()!; if (id === parent) return true;
        if (!seen.has(id)) { seen.add(id); pending.push(...terms.get(id)!.broader); } }
      return false;
    };
    return noted({ version: v, a: a.id, b: b.id, keys: { a: keys.key(a), b: keys.key(b) }, relationship: a.id === b.id ? 'equivalent'
      : ancestor(a.id, b.id) ? 'subsumes' : ancestor(b.id, a.id) ? 'subsumed-by' : 'not-subsumed' }, [notice(args.a, foundA), notice(args.b, foundB)]);
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
  server.registerTool('list_subscribers', { description: 'List consumers that follow the changelog: how far each has applied it (through), what is still pending for its schemes (including breaking changes), and any change it is held at, with a code and reason.',
    inputSchema: z.object({}).strict(), annotations }, () => run(() => ({ log: store.logId, version: store.version, subscribers: store.subscribers() })));
  server.registerTool('propose_term', { description: 'Propose a new term under an existing broader term (stable ID, alias, scheme:slug or bare slug), copied from a term in a reference vocabulary. First find the source with search_terms (scheme loc-classification, or excludeScheme set to the target scheme); if nothing fits even broadly, leave the addition to a person. A scheme whose proposalSource is optional (see list_schemes; human-work is one) also takes a proposal with no source, backed by evidence such as the quote a concept was coined from: pass label and evidence instead. In a concept graph, broader may be left out. The label defaults to the source label, and the new term links to the source with match (closeMatch by default; use broadMatch when the source is wider). It is created at once as provisional with a server-minted slug, and the owner confirms, merges or retires it in the editor. Pass a slug to request a specific one. An existing term with the same slug or label in that place is refused with its id, slug and status; a retired match says so. A close or exact match is also refused when a sibling already has a close or exact match to the same source, and an exact match when any term in the scheme already has one. Reuse requestId on retries to get the original term back instead of a duplicate.',
    inputSchema: z.object({ scheme: z.string().min(1).max(200), broader: ref.optional().describe('The term this goes under. Optional in a concept graph.'),
      source: z.string().min(1).max(2000).optional().describe('The reference term to copy, in another scheme: stable ID, alias, IRI or notation (e.g. "QA76.9.H85"). Required unless the scheme\'s proposalSource is optional and evidence is given.'),
      sourceScheme: z.string().min(1).max(200).optional().describe('The scheme to resolve source in, when a notation or alias repeats.'),
      match: z.enum(['closeMatch', 'broadMatch', 'narrowMatch', 'exactMatch', 'relatedMatch']).optional()
        .describe('How the new term relates to the source: broadMatch means the source is wider. Defaults to closeMatch.'),
      label: z.string().min(1).max(200).optional().describe('Defaults to the source label.'),
      scopeNote: z.string().max(20000).optional(), altLabels: z.array(z.string().min(1).max(200)).max(100).optional(),
      slug: z.string().min(1).max(80).optional(),
      proposer: z.string().min(1).max(200).optional().describe('Who is proposing, e.g. "concept-clusters:authoring". Required on the LAN; Access callers are named by their verified identity.'),
      evidence: z.record(z.string(), z.unknown()).optional().describe('Why the term is needed, e.g. {"puzzleId": "…"} or {"quote": 412, "text": "…"}. At most 4 KiB of JSON.'),
      requestId: z.string().min(1).max(200).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  args => run(() => store.propose(args, options.caller)));
  server.registerTool('export_skos', { description: 'Export a scheme and its collections as SKOS Turtle at a version, including notations, mappings and collection definitions. Limited to 1 MiB; use the REST export for larger vocabularies.',
    inputSchema: z.object({ scheme: z.string().min(1).max(200), at }).strict(), annotations }, args => run(async () => {
    const v = version(args.at); return { version: v, mediaType: 'text/turtle', data: await exportSkos(store, args.scheme, v) };
  }));
  return server;
}
