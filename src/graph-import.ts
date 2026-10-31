import { z } from 'zod';
import { DomainError, importPlanSchema, iriSchema } from './model.js';
import type { Store } from './store.js';
import type { ImportRequest } from './skos.js';
import { analyseStructure } from './import-structure.js';
const nodeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(), scheme: z.string(), slug: z.string().optional(), key: iriSchema.optional(),
  label: z.string(), alt_labels: z.array(z.string()).nullable().optional(), altLabels: z.array(z.string()).optional(),
  definition: z.string().nullable().optional(), scopeNote: z.string().optional(), status: z.string().optional(),
  source: z.string().nullable().optional(), sourceUri: iriSchema.optional(), aliases: z.array(z.string()).optional(),
  close_match: z.string().nullable().optional(), links: z.array(z.unknown()).optional(), notations: z.array(z.unknown()).optional(),
  language: z.string().optional(),
});
const documentSchema = z.object({
  format: z.enum(['quote-mcp-export/1', 'terminology-graph/1']),
  schemes: z.array(z.object({ id: z.union([z.string(), z.number()]), slug: z.string().optional(), label: z.string(),
    description: z.string().optional(), sourceUri: iriSchema.optional(), hierarchy: z.string().optional(), notations: z.array(z.unknown()).optional() })).min(1).max(1000),
  concepts: z.array(nodeSchema).max(10000),
  relations: z.array(z.object({ from: z.string(), to: z.string(), type: z.enum(['broader', 'narrower', 'related', 'opposite', 'inverse']) })).max(100000),
});
function document(data: string) {
  if (Buffer.byteLength(data) > 5 * 1024 * 1024) throw new DomainError(413, 'Graph JSON is limited to 5 MiB.');
  try { return documentSchema.parse(JSON.parse(data)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new DomainError(422, 'Invalid graph JSON.');
    throw error;
  }
}
const encoded = (value: string) => encodeURIComponent(value);
function identity(scheme: z.infer<typeof documentSchema>['schemes'][number], quote: boolean) {
  const key = scheme.slug ?? String(scheme.id);
  return { key, uri: scheme.sourceUri ?? `${quote ? 'urn:quote-mcp' : 'urn:terminology-mcp'}:scheme:${encoded(key)}` };
}
export function graphSchemes(data: string) {
  const input = document(data), quote = input.format === 'quote-mcp-export/1';
  return input.schemes.map(scheme => ({ uri: identity(scheme, quote).uri, label: scheme.label }));
}
export function planGraph(_store: Store, data: string, request: ImportRequest) {
  const input = document(data), quote = input.format === 'quote-mcp-export/1';
  const scheme = input.schemes.find(scheme => identity(scheme, quote).uri === request.sourceScheme);
  if (!scheme) throw new DomainError(422, 'Selected scheme is not declared in this graph.');
  const { key: schemeKey, uri: schemeUri } = identity(scheme, quote), warnings = new Set<string>();
  if (quote) warnings.add('Importing vocabulary metadata and relationships only; works and quotes are not imported.');
  const nodes = input.concepts.filter(node => node.scheme === schemeKey || node.scheme === String(scheme.id));
  const references = new Map<string, string>();
  const keys = new Set<string>();
  const nodeKey = (node: typeof nodes[number]) => node.sourceUri ?? node.key ?? (quote && node.slug
    ? `urn:quote-mcp:concept:${encoded(schemeKey)}:${encoded(node.slug)}`
    : node.id !== undefined ? `urn:terminology-mcp:term:${encoded(String(node.id))}` : '');
  for (const node of nodes) {
    const key = iriSchema.parse(nodeKey(node));
    if (keys.has(key)) throw new DomainError(422, 'Duplicate graph concept identity.'); keys.add(key);
    for (const ref of [node.id === undefined ? undefined : String(node.id), node.slug, node.key, node.sourceUri, key]) if (ref) {
      if (references.has(ref) && references.get(ref) !== key) throw new DomainError(422, `Ambiguous graph reference: ${ref}`);
      references.set(ref, key);
    }
  }
  const terms = nodes.map(node => {
    const key = nodeKey(node), status = node.status === 'confirmed' || node.status === undefined ? 'active' : node.status;
    const links = [...node.links ?? []];
    if (node.close_match && node.close_match !== 'NA') {
      if (iriSchema.safeParse(node.close_match).success) links.push({ uri: node.close_match, match: 'closeMatch' });
      else warnings.add('Non-IRI WordNet references omitted.');
    }
    return { key, label: node.label, altLabels: node.altLabels ?? node.alt_labels ?? [], scopeNote: node.scopeNote ?? node.definition ?? '', status,
      sourceUri: key, language: node.language, aliases: [...new Set([...node.aliases ?? [],
        ...(quote && node.slug ? [`quote-mcp:${schemeKey}:${node.slug}`] : []), ...(node.source ? [node.source] : []),
        ...(!quote && typeof node.id === 'string' ? [node.id] : [])])],
      broader: [] as string[], relations: [] as { type: 'related' | 'opposite'; target: string }[], links, notations: node.notations ?? [] };
  });
  const byKey = new Map(terms.map(term => [term.key, term]));
  for (const edge of input.relations) {
    const from = references.get(edge.from), to = references.get(edge.to);
    if (!from && !to) {
      if (input.schemes.length === 1) throw new DomainError(422, `Unresolved graph edge: ${edge.from} → ${edge.to}`);
      continue;
    }
    if (!from || !to) throw new DomainError(422, 'A graph edge crosses the selected scheme or has a missing endpoint. Import schemes separately and add cross-scheme links explicitly.');
    if (edge.type === 'broader') byKey.get(from)!.broader.push(to);
    else if (edge.type === 'narrower') byKey.get(to)!.broader.push(from);
    else {
      const type = edge.type === 'inverse' ? 'opposite' : edge.type;
      byKey.get(from)!.relations.push({ type, target: to }); byKey.get(to)!.relations.push({ type, target: from });
    }
  }
  for (const term of terms) {
    term.broader = [...new Set(term.broader)];
    term.relations = [...new Map(term.relations.map(edge => [`${edge.type}:${edge.target}`, edge])).values()];
  }
  const plan = importPlanSchema.parse({ scheme: { id: request.schemeId, label: request.label || scheme.label,
    description: scheme.description ?? '', hierarchy: 'graph', sourceUri: schemeUri, notations: scheme.notations ?? [] }, terms });
  const analysis = analyseStructure(plan, request.hierarchy, scheme.hierarchy, quote);
  return { plan, analysis, warnings: [...warnings] };
}
