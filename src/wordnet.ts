/**
 * Readable names for Open English WordNet links. A term's WordNet link is a synset id
 * (https://en-word.net/id/oewn-07531593-n), stable across editions but unreadable; this asks the WordNet server
 * (quote-mcp's docs/wordnet.md) for the synset's words, part of speech and definition, so the editor can show
 * them beside the link. Storage never changes, and a lookup never blocks a term load or save: the editor asks
 * separately, and an unreachable server only means the bare id is shown.
 */
export const OEWN_ID = 'https://en-word.net/id/';
export const DEFAULT_WORDNET_SPARQL = 'http://wordnet.localdomain:7878';
export const DEFAULT_WORDNET_GRAPH = 'urn:wordnet:graph:oewn-2025';

export type Synset = { uri: string; found: boolean; words?: string[]; pos?: string; definition?: string };
export type WordnetConfig = { baseUrl: string; graph: string; timeoutMs: number };
export type WordnetLookup = (uri: string) => Promise<Synset | null>;

/** WORDNET_SPARQL=off turns lookups off; unset means the LAN server. WORDNET_GRAPH names the edition's graph. */
export function wordnetConfig(env: NodeJS.ProcessEnv = process.env): WordnetConfig | null {
  const raw = env.WORDNET_SPARQL?.trim() ?? '';
  if (raw.toLowerCase() === 'off') return null;
  return { baseUrl: (raw || DEFAULT_WORDNET_SPARQL).replace(/\/+$/, ''),
    graph: env.WORDNET_GRAPH?.trim() || DEFAULT_WORDNET_GRAPH, timeoutMs: 3000 };
}

/** The synset id in a link ("oewn-07531593-n"), or null for any other link or one unsafe to put in a query. */
export function synsetId(uri: string): string | null {
  if (!uri.startsWith(OEWN_ID)) return null;
  const id = uri.slice(OEWN_ID.length);
  return /^[\w.-]+$/.test(id) ? id : null;
}

export function synsetQuery(id: string, graph: string) {
  if (!/^[\w.-]+$/.test(id) || /[<>\s]/.test(graph)) throw new Error('Unsafe synset id or graph name.');
  return `PREFIX wn: <https://globalwordnet.github.io/schemas/wn#>
PREFIX ontolex: <http://www.w3.org/ns/lemon/ontolex#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?pos ?def ?word WHERE {
  BIND(<${OEWN_ID}${id}> AS ?synset)
  GRAPH <${graph}> {
    ?synset wn:partOfSpeech ?pos ; wn:definition ?d . ?d rdf:value ?def .
    ?sense ontolex:isLexicalizedSenseOf ?synset . ?entry ontolex:sense ?sense ; ontolex:canonicalForm ?f . ?f ontolex:writtenRep ?word
  }
}`;
}

type Binding = Record<string, { value: string } | undefined>;
export function synsetFrom(uri: string, rows: Binding[]): Synset {
  if (!rows.length) return { uri, found: false };
  const pos = rows[0].pos?.value.replace(/^.*[#/]/, '');
  const words = [...new Set(rows.flatMap(row => row.word ? [row.word.value] : []))].sort((a, b) => a.localeCompare(b));
  return { uri, found: true, words, pos, definition: rows[0].def?.value };
}

/** Drops a failed answer so the next request asks again, unless a newer request has already replaced it. */
function forget<T>(cache: Map<string, Promise<T>>, key: string, answer: Promise<T>) {
  if (cache.get(key) === answer) cache.delete(key);
}

/**
 * A cached lookup. Answers (found or not) are kept per id, up to `limit` ids; a failure is not kept, so the next
 * request tries the server again. Resolves null for a link that isn't a synset id or when the server can't answer.
 */
export function wordnetLookup(config: WordnetConfig | null, fetchImpl: typeof fetch = fetch, limit = 5000): WordnetLookup {
  const cache = new Map<string, Promise<Synset | null>>();
  return uri => {
    const id = synsetId(uri);
    if (!config || !id) return Promise.resolve(null);
    const cached = cache.get(id);
    if (cached) return cached.then(synset => synset && { ...synset, uri });
    const answer: Promise<Synset | null> = (async () => {
      const response = await fetchImpl(`${config.baseUrl}/query`, {
        method: 'POST', body: new URLSearchParams({ query: synsetQuery(id, config.graph) }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`WordNet server answered ${response.status}`);
      const body = await response.json() as { results: { bindings: Binding[] } };
      return synsetFrom(uri, body.results.bindings);
    })().catch(() => { forget(cache, id, answer); return null; });
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(id, answer);
    return answer;
  };
}

/** A word as WordNet spells its lemmas: as typed, lower case, and capitalised ("anger", "Anger"); spaces kept. */
export function searchForms(word: string): string[] {
  const typed = word.trim().replace(/\s+/g, ' ');
  if (!typed || typed.length > 100) return [];
  const lower = typed.toLowerCase();
  return [...new Set([typed, lower, lower.charAt(0).toUpperCase() + lower.slice(1)])];
}

/** The synsets with a lemma spelled exactly as one of `forms`. Whole words only: a prefix search would scan all of WordNet. */
export function searchQuery(forms: string[], graph: string) {
  if (/[<>\s]/.test(graph)) throw new Error('Unsafe graph name.');
  return `PREFIX wn: <https://globalwordnet.github.io/schemas/wn#>
PREFIX ontolex: <http://www.w3.org/ns/lemon/ontolex#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?synset ?pos ?def ?word WHERE {
  VALUES ?rep { ${forms.map(form => `${JSON.stringify(form)}@en`).join(' ')} }
  GRAPH <${graph}> {
    ?f ontolex:writtenRep ?rep . ?e ontolex:canonicalForm ?f ; ontolex:sense ?s . ?s ontolex:isLexicalizedSenseOf ?synset .
    ?synset wn:partOfSpeech ?pos ; wn:definition ?d . ?d rdf:value ?def .
    ?s2 ontolex:isLexicalizedSenseOf ?synset . ?e2 ontolex:sense ?s2 ; ontolex:canonicalForm ?f2 . ?f2 ontolex:writtenRep ?word
  }
}`;
}

/** Folds the search rows into one synset each, nouns first, in the server's order otherwise. */
export function searchResults(rows: Binding[]): Synset[] {
  const bySynset = new Map<string, Binding[]>();
  for (const row of rows) {
    const uri = row.synset?.value;
    if (!uri?.startsWith(OEWN_ID)) continue;
    bySynset.set(uri, [...bySynset.get(uri) ?? [], row]);
  }
  const order = ['noun', 'verb', 'adjective', 'adjective_satellite', 'adverb'];
  const rank = (synset: Synset) => { const i = order.indexOf(synset.pos ?? ''); return i < 0 ? order.length : i; };
  return [...bySynset].map(([uri, group]) => synsetFrom(uri, group)).sort((a, b) => rank(a) - rank(b));
}

export type WordnetSearch = (word: string) => Promise<Synset[] | null>;

/** A cached search. Resolves null when lookups are off or the server can't answer; [] when nothing matches. */
export function wordnetSearch(config: WordnetConfig | null, fetchImpl: typeof fetch = fetch, limit = 500): WordnetSearch {
  const cache = new Map<string, Promise<Synset[] | null>>();
  return word => {
    const forms = searchForms(word);
    if (!config) return Promise.resolve(null);
    if (!forms.length) return Promise.resolve([]);
    const key = forms[0].toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;
    const answer: Promise<Synset[] | null> = (async () => {
      const response = await fetchImpl(`${config.baseUrl}/query`, {
        method: 'POST', body: new URLSearchParams({ query: searchQuery(forms, config.graph) }),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) throw new Error(`WordNet server answered ${response.status}`);
      const body = await response.json() as { results: { bindings: Binding[] } };
      return searchResults(body.results.bindings);
    })().catch(() => { forget(cache, key, answer); return null; });
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(key, answer);
    return answer;
  };
}
