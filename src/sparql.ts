import { iriSchema, DomainError } from './model.js';
import { SKOS } from './skos.js';

const iri = (value: string) => `<${iriSchema.parse(value)}>`;
function endpointUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError(422, 'Invalid SPARQL endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new DomainError(422, 'Use an HTTP(S) SPARQL query endpoint without credentials, query, or fragment.');
  return url.href;
}
export function schemeQuery(graph?: string) {
  const pattern = `?scheme a <${SKOS}ConceptScheme> . OPTIONAL { ?scheme <${SKOS}prefLabel> ?label }`;
  return `SELECT DISTINCT ?scheme ?label WHERE { ${graph ? `GRAPH ${iri(graph)} { ${pattern} }` : pattern} } ORDER BY ?scheme ?label LIMIT 1001`;
}
export function importQuery(scheme: string, graph?: string) {
  const s = iri(scheme);
  const members = `{ ?member <${SKOS}inScheme> ${s} } UNION { ?member <${SKOS}topConceptOf> ${s} } UNION { ${s} <${SKOS}hasTopConcept> ?member }`;
  const pattern = `{ BIND(${s} AS ?subject) ?subject ?predicate ?object }
    UNION { { ${members} } BIND(?member AS ?subject) ?subject ?predicate ?object }
    UNION { { ${members} } ?subject ?predicate ?member .
      VALUES ?predicate { <${SKOS}hasTopConcept> <${SKOS}broader> <${SKOS}narrower> <${SKOS}related>
        <${SKOS}exactMatch> <${SKOS}closeMatch> <${SKOS}broadMatch> <${SKOS}narrowMatch> <${SKOS}relatedMatch> }
      BIND(?member AS ?object) }
    UNION { ?collection (<${SKOS}member>|<${SKOS}memberList>/<http://www.w3.org/1999/02/22-rdf-syntax-ns#rest>*/<http://www.w3.org/1999/02/22-rdf-syntax-ns#first>)* ?collectionMember .
      { ?collectionMember <${SKOS}inScheme> ${s} } UNION { ?collectionMember <${SKOS}topConceptOf> ${s} } UNION { ${s} <${SKOS}hasTopConcept> ?collectionMember }
      { ?collection a ?collectionType . VALUES ?collectionType { <${SKOS}Collection> <${SKOS}OrderedCollection> } }
      UNION { ?collection <${SKOS}member> ?directMember }
      UNION { ?collection <${SKOS}memberList> ?listHead }
      ?collection (<${SKOS}member>|<${SKOS}memberList>/<http://www.w3.org/1999/02/22-rdf-syntax-ns#rest>*/<http://www.w3.org/1999/02/22-rdf-syntax-ns#first>)* ?node .
      { BIND(?node AS ?subject) ?subject ?predicate ?object }
      UNION { ?node <${SKOS}memberList>/<http://www.w3.org/1999/02/22-rdf-syntax-ns#rest>* ?subject . ?subject ?predicate ?object } }
    UNION { ?collection <urn:terminology-mcp:vocab:scheme> ${s} .
      { BIND(?collection AS ?subject) ?subject ?predicate ?object }
      UNION { ?collection <${SKOS}memberList>/<http://www.w3.org/1999/02/22-rdf-syntax-ns#rest>* ?subject . ?subject ?predicate ?object } }`;
  return `CONSTRUCT { ?subject ?predicate ?object } WHERE { ${graph ? `GRAPH ${iri(graph)} { ${pattern} }` : pattern} }`;
}
async function query(endpoint: string, sparql: string, accept: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(endpointUrl(endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/sparql-query', Accept: accept }, body: sparql });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(502, `Could not query SPARQL source: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) { await response.body?.cancel(); throw new DomainError(502, `SPARQL source returned HTTP ${response.status}.`); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new DomainError(502, 'SPARQL source returned no body.');
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 5 * 1024 * 1024) throw new DomainError(413, 'SPARQL response exceeds 5 MiB; choose a smaller source graph.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function discoverSchemes(endpoint: string, graph?: string) {
  const data = await query(endpoint, schemeQuery(graph), 'application/sparql-results+json');
  try {
    const rows = JSON.parse(data).results.bindings as { scheme: { type: string; value: string }; label?: { value: string; 'xml:lang'?: string } }[];
    if (rows.length > 1000) throw new DomainError(413, 'More than 1,000 scheme labels; select a narrower source graph.');
    return rows.map(row => ({ uri: iriSchema.parse(row.scheme.value), label: row.label?.value ?? row.scheme.value, language: row.label?.['xml:lang'] ?? '' }));
  } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(502, 'Invalid SPARQL scheme listing.'); }
}
export function fetchScheme(endpoint: string, scheme: string, graph?: string) {
  return query(endpoint, importQuery(scheme, graph), 'text/turtle');
}
