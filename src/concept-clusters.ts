/**
 * Readable names for links to Concept Clusters puzzles. A term can link (closeMatch, relatedMatch…) to a puzzle or
 * to one of its clusters, terms or bridges by Concept Clusters' IRI (urn:concept-clusters:puzzle:<id>#<item>). This
 * reads Concept Clusters' published graphs on the LAN Oxigraph server (concept-clusters' docs/ONTOLOGY.md) to name
 * the item, give its fact or note, and give the puzzle's title and public URL, which an article can cite.
 *
 * Read only: Concept Clusters owns those graphs, and every query names them by their urn:concept-clusters:graph:
 * prefix. As with WordNet, a lookup never blocks a term load or save, and an unreachable server only means the bare
 * IRI is shown.
 */
export const CC_PUZZLE = 'urn:concept-clusters:puzzle:';
const CC_GRAPH = 'urn:concept-clusters:graph:puzzle:';
export const DEFAULT_CC_SPARQL = 'http://oxigraph.localdomain:7878';
export const DEFAULT_CC_SITE = 'https://concept-clusters.jmajerus.workers.dev/';

export type CcKind = 'puzzle' | 'cluster' | 'term' | 'bridge' | 'lens';
export type CcPuzzle = { id: string; uri: string; title: string; url: string };
export type CcItem = {
  uri: string; found: boolean; kind?: CcKind; label?: string;
  /** A cluster's or bridge's fact, a term's note, a lens's prompt, or a puzzle's description. */
  text?: string;
  /** A cluster's terms. */
  terms?: string[];
  /** The cluster a term is in. */
  cluster?: { uri: string; label: string };
  /** The two clusters a bridge connects, and its kind (dynamic, contrast…). */
  connects?: { uri: string; label: string }[]; relationKind?: string;
  puzzle?: CcPuzzle;
};
export type CcConfig = { baseUrl: string; site: string; timeoutMs: number };
export type CcLookup = (uri: string) => Promise<CcItem | null>;
export type CcSearch = (text: string) => Promise<CcItem[] | null>;

/** CC_SPARQL=off turns lookups off; unset means the LAN server. CC_SITE is the player site puzzles link to. */
export function ccConfig(env: NodeJS.ProcessEnv = process.env): CcConfig | null {
  const raw = env.CC_SPARQL?.trim() ?? '';
  if (raw.toLowerCase() === 'off') return null;
  const site = (env.CC_SITE?.trim() || DEFAULT_CC_SITE).replace(/\/*$/, '/');
  return { baseUrl: (raw || DEFAULT_CC_SPARQL).replace(/\/+$/, ''), site, timeoutMs: 3000 };
}

/** The puzzle id and item fragment of a Concept Clusters IRI, or null for any other link or one unsafe to put in a query. */
export function ccParts(uri: string): { puzzle: string; item: string | null } | null {
  if (!uri.startsWith(CC_PUZZLE)) return null;
  const [puzzle, item, ...rest] = uri.slice(CC_PUZZLE.length).split('#');
  if (rest.length || !/^[A-Za-z0-9._~-]+$/.test(puzzle)) return null;
  if (item !== undefined && !/^[A-Za-z0-9._~/-]+$/.test(item)) return null;
  return { puzzle, item: item ?? null };
}

export const puzzleUrl = (config: CcConfig, id: string) => `${config.site}?puzzle=${encodeURIComponent(id)}`;

const PREFIXES = `PREFIX cc: <https://concept-clusters.org/vocab#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX schema: <https://schema.org/>`;

export function lookupQuery(puzzle: string, item: string | null) {
  const p = `<${CC_PUZZLE}${puzzle}>`, x = item === null ? p : `<${CC_PUZZLE}${puzzle}#${item}>`;
  return `${PREFIXES}
SELECT ?title ?type ?name ?text ?member ?kind ?cluster ?clusterName ?end ?endName WHERE {
  GRAPH <${CC_GRAPH}${puzzle}> {
    ${p} schema:name ?title .
    OPTIONAL {
      ${x} a ?type .
      OPTIONAL { ${x} schema:name|skos:prefLabel ?name }
      OPTIONAL { ${x} cc:fact|cc:note|cc:prompt|schema:description ?text }
      OPTIONAL { ${x} cc:term ?m . ?m skos:prefLabel ?member }
      OPTIONAL { ${x} cc:relationKind ?kind }
      OPTIONAL { ${x} cc:inCluster ?cluster . ?cluster schema:name ?clusterName }
      OPTIONAL { ${x} cc:connectsCluster ?end . ?end schema:name ?endName }
    }
  }
}`;
}

type Binding = Record<string, { value: string } | undefined>;
const KINDS: Record<string, CcKind> = { Puzzle: 'puzzle', Cluster: 'cluster', Term: 'term', Bridge: 'bridge', Lens: 'lens' };
const kindOf = (type?: string) => type ? KINDS[type.replace(/^.*[#/]/, '')] : undefined;

export function itemFrom(config: CcConfig, uri: string, rows: Binding[]): CcItem {
  const parts = ccParts(uri);
  const kind = kindOf(rows.find(row => row.type)?.type?.value);
  if (!parts || !rows.length || !kind) return { uri, found: false };
  const first = rows[0], distinct = (key: string) => [...new Set(rows.flatMap(row => row[key] ? [row[key]!.value] : []))];
  const ends = new Map(rows.flatMap(row => row.end && row.endName ? [[row.end.value, row.endName.value] as const] : []));
  const cluster = rows.find(row => row.cluster && row.clusterName);
  return {
    uri, found: true, kind,
    ...(first.name ? { label: first.name.value } : {}),
    ...(first.text ? { text: first.text.value } : {}),
    ...(kind === 'cluster' ? { terms: distinct('member') } : {}),
    ...(cluster ? { cluster: { uri: cluster.cluster!.value, label: cluster.clusterName!.value } } : {}),
    ...(ends.size ? { connects: [...ends].map(([uri, label]) => ({ uri, label })) } : {}),
    ...(first.kind ? { relationKind: first.kind.value } : {}),
    puzzle: { id: parts.puzzle, uri: CC_PUZZLE + parts.puzzle, title: first.title!.value, url: puzzleUrl(config, parts.puzzle) },
  };
}

async function select(config: CcConfig, fetchImpl: typeof fetch, query: string): Promise<Binding[]> {
  const response = await fetchImpl(`${config.baseUrl}/query`, {
    method: 'POST', body: new URLSearchParams({ query }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Concept Clusters' graph server answered ${response.status}`);
  return (await response.json() as { results: { bindings: Binding[] } }).results.bindings;
}

/** Drops a failed answer so the next request asks again, unless a newer request has already replaced it. */
function forget<T>(cache: Map<string, Promise<T>>, key: string, answer: Promise<T>) {
  if (cache.get(key) === answer) cache.delete(key);
}

/**
 * A cached lookup. Answers are kept for `ttlMs` (puzzles are republished, unlike WordNet editions), up to `limit`
 * IRIs; a failure is not kept. Resolves null for a link that isn't a Concept Clusters IRI or when the server can't
 * answer, and found: false for an IRI the published graphs don't have (a withdrawn puzzle, a renamed item).
 */
export function ccLookup(config: CcConfig | null, fetchImpl: typeof fetch = fetch, limit = 5000, ttlMs = 10 * 60_000): CcLookup {
  const cache = new Map<string, Promise<CcItem | null>>(), stamps = new Map<string, number>();
  return uri => {
    const parts = ccParts(uri);
    if (!config || !parts) return Promise.resolve(null);
    const cached = cache.get(uri);
    if (cached && Date.now() - stamps.get(uri)! < ttlMs) return cached;
    const answer: Promise<CcItem | null> = select(config, fetchImpl, lookupQuery(parts.puzzle, parts.item))
      .then(rows => itemFrom(config, uri, rows))
      .catch(() => { forget(cache, uri, answer); return null; });
    if (!cached && cache.size >= limit) { const oldest = cache.keys().next().value!; cache.delete(oldest); stamps.delete(oldest); }
    cache.set(uri, answer); stamps.set(uri, Date.now());
    return answer;
  };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'onto', 'its', 'their', 'that', 'this', 'not', 'are', 'was', 'how', 'why', 'what', 'who']);

/**
 * The words of a search as crude stems, so "Inversion of Moral Orientation" finds "Inverting moral value": a common
 * suffix is dropped and the rest cut to five letters (inversion, inverting → inver). Short and common words are skipped.
 */
export function searchStems(text: string): string[] {
  const words = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]+/g) ?? [];
  const stems = words.filter(word => word.length >= 3 && !STOP.has(word)).map(word => {
    const bare = word.length > 5 ? word.replace(/(?:ations?|itions?|ings?|ments?|ness|ities|ity|ery|ies|ions?|ed|es|s)$/, '') : word;
    return (bare.length >= 4 ? bare : word).slice(0, 5);
  });
  return [...new Set(stems)].slice(0, 8);
}

/** Clusters, terms and bridges whose label or fact has a word starting with one of the stems, in any published puzzle. */
export function searchQuery(stems: string[]) {
  if (!stems.length || stems.some(stem => !/^[a-z0-9]+$/.test(stem))) throw new Error('Unsafe search stems.');
  // At the start of a word, so "war" doesn't find "toward".
  const any = (v: string) => stems.map(stem => `REGEX(${v}, "(^|[^a-z0-9])${stem}")`).join(' || ');
  return `${PREFIXES}
SELECT ?x ?type ?name ?text ?p ?title ?cluster ?clusterName ?kind WHERE {
  GRAPH ?g {
    { ?x a cc:Cluster ; schema:name ?name . ?p cc:hasCluster ?x }
    UNION { ?x a cc:Term ; skos:prefLabel ?name ; cc:inPuzzle ?p . OPTIONAL { ?x cc:inCluster ?cluster . ?cluster schema:name ?clusterName } }
    UNION { ?x a cc:Bridge ; skos:prefLabel ?name ; cc:inPuzzle ?p . OPTIONAL { ?x cc:relationKind ?kind } }
    OPTIONAL { ?x cc:fact|cc:note ?text }
    BIND(LCASE(STR(?name)) AS ?n) BIND(LCASE(STR(COALESCE(?text, ""))) AS ?t)
    FILTER(${any('?n')} || ${any('?t')})
    ?x a ?type . ?p schema:name ?title .
  }
  FILTER(STRSTARTS(STR(?g), "${CC_GRAPH}"))
} LIMIT 3000`;
}

/**
 * One result per item, best first: the label exactly, then the label containing the whole text, then by how many of
 * the words the label (twice over) and the fact match; clusters before terms before bridges on a tie.
 */
export function searchResults(config: CcConfig, text: string, rows: Binding[], max = 40): CcItem[] {
  const needle = text.trim().replace(/\s+/g, ' ').toLowerCase(), stems = searchStems(text), order: CcKind[] = ['cluster', 'term', 'bridge'];
  const items = new Map<string, CcItem>();
  for (const row of rows) {
    const uri = row.x?.value, kind = kindOf(row.type?.value), parts = uri ? ccParts(uri) : null;
    if (!uri || !kind || !parts || items.has(uri) || !row.name || !row.title) continue;
    items.set(uri, { uri, found: true, kind, label: row.name.value, ...(row.text ? { text: row.text.value } : {}),
      ...(row.cluster && row.clusterName ? { cluster: { uri: row.cluster.value, label: row.clusterName.value } } : {}),
      ...(row.kind ? { relationKind: row.kind.value } : {}),
      puzzle: { id: parts.puzzle, uri: CC_PUZZLE + parts.puzzle, title: row.title.value, url: puzzleUrl(config, parts.puzzle) } });
  }
  const score = (item: CcItem) => {
    const label = item.label!.toLowerCase(), fact = (item.text ?? '').toLowerCase();
    return (label === needle ? 1000 : 0) + (label.includes(needle) ? 500 : 0)
      + stems.reduce((sum, stem) => { const word = new RegExp(`(^|[^a-z0-9])${stem}`); return sum + (word.test(label) ? 2 : 0) + (word.test(fact) ? 1 : 0); }, 0);
  };
  const scored = new Map([...items.values()].map(item => [item, score(item)]));
  return [...items.values()].sort((a, b) => scored.get(b)! - scored.get(a)! || order.indexOf(a.kind!) - order.indexOf(b.kind!)
    || a.label!.localeCompare(b.label!) || a.puzzle!.title.localeCompare(b.puzzle!.title)).slice(0, max);
}

/** A cached search (for `ttlMs`). Resolves null when lookups are off or the server can't answer; [] when nothing matches. */
export function ccSearch(config: CcConfig | null, fetchImpl: typeof fetch = fetch, limit = 500, ttlMs = 10 * 60_000): CcSearch {
  const cache = new Map<string, Promise<CcItem[] | null>>(), stamps = new Map<string, number>();
  return text => {
    const key = text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!config) return Promise.resolve(null);
    if (key.length < 2 || key.length > 100 || !searchStems(key).length) return Promise.resolve([]);
    const cached = cache.get(key);
    if (cached && Date.now() - stamps.get(key)! < ttlMs) return cached;
    const answer: Promise<CcItem[] | null> = select(config, fetchImpl, searchQuery(searchStems(key)))
      .then(rows => searchResults(config, key, rows))
      .catch(() => { forget(cache, key, answer); return null; });
    if (!cached && cache.size >= limit) { const oldest = cache.keys().next().value!; cache.delete(oldest); stamps.delete(oldest); }
    cache.set(key, answer); stamps.set(key, Date.now());
    return answer;
  };
}
