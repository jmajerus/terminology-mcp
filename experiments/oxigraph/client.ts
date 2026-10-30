export const prefixes = `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX ex: <urn:terminology-mcp:vocab:>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n`;

export function iri(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || /[\u0000-\u0020<>"{}|^`\\]/u.test(value))
    throw new Error('Invalid absolute RDF IRI.');
  return `<${value}>`;
}
export const literal = (value: string) => JSON.stringify(value);
export const namespacePattern = /^urn:terminology-mcp:feasibility:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:$/;
export function ownedGraph(namespace: string, graph: string): string {
  if (!namespacePattern.test(namespace) || !graph.startsWith(namespace) ||
      !/^[a-z0-9:-]+$/.test(graph.slice(namespace.length)) || graph === namespace)
    throw new Error('Refusing a graph outside this feasibility run.');
  return iri(graph);
}
export type Binding = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
export type Results = { head: { vars: string[] }; results: { bindings: Record<string, Binding>[] } };
export type Trace = { kind: string; name: string; body: string; ms: number; status?: number; error?: string };

export class OxigraphError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class Client {
  readonly endpoint: string;
  readonly trace: Trace[] = [];
  server = 'unknown';
  constructor(endpoint: string) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Use an HTTP(S) server URL without embedded credentials, query, or fragment.');
    this.endpoint = url.href.replace(/\/$/, '');
  }
  private async request(kind: 'query' | 'update' | 'store', name: string, body: string, accept: string, graph?: string) {
    const trace: Trace = { kind, name, body: kind === 'store' ? body : prefixes + body, ms: 0 };
    this.trace.push(trace);
    const started = performance.now();
    try {
      const response = await fetch(`${this.endpoint}/${kind}${graph ? `?graph=${encodeURIComponent(graph)}` : ''}`, {
        method: kind === 'store' ? 'PUT' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': kind === 'store' ? 'text/turtle' : `application/sparql-${kind}`, Accept: accept },
        body: trace.body,
      });
      trace.status = response.status;
      this.server = response.headers.get('server') ?? this.server;
      const body = await response.text();
      if (!response.ok) throw new OxigraphError(response.status, body.slice(0, 2000));
      return body;
    } catch (error) {
      trace.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { trace.ms = Math.round((performance.now() - started) * 100) / 100; }
  }
  async select(name: string, sparql: string): Promise<Results> {
    return JSON.parse(await this.request('query', name, sparql, 'application/sparql-results+json'));
  }
  async ask(name: string, sparql: string): Promise<boolean> {
    return JSON.parse(await this.request('query', name, sparql, 'application/sparql-results+json')).boolean;
  }
  async update(name: string, sparql: string) { await this.request('update', name, sparql, '*/*'); }
  async turtle(name: string, sparql: string) {
    return this.request('query', name, sparql, 'text/turtle');
  }
  async loadTurtle(name: string, namespace: string, graph: string, turtle: string) {
    ownedGraph(namespace, graph);
    await this.request('store', name, turtle, '*/*', graph);
  }
}

// Explicit graph names only: never DROP ALL, CLEAR ALL, or the default graph.
export function cleanupStatement(namespace: string, graphs: string[]): string {
  if (!graphs.length) throw new Error('No owned graphs to clean up.');
  return [...new Set(graphs)].map(graph => `DROP SILENT GRAPH ${ownedGraph(namespace, graph)}`).join(';\n');
}
