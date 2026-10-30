import { z } from 'zod';
import { DomainError, type TermView } from './model.js';
import type { Store } from './store.js';
export const graphTypes = ['broader', 'narrower', 'related', 'opposite'] as const;
export type GraphType = typeof graphTypes[number];
export type GraphEdge = { from: string; to: string; type: GraphType };
export function graphEdges(terms: TermView[]): GraphEdge[] {
  const ids = new Set(terms.map(term => term.id)), edges = new Map<string, GraphEdge>();
  const add = (from: string, to: string, type: GraphType) => { if (ids.has(from) && ids.has(to)) edges.set(`${type}:${from}:${to}`, { from, to, type }); };
  for (const term of terms) {
    for (const parent of term.broader) { add(term.id, parent, 'broader'); add(parent, term.id, 'narrower'); }
    for (const relation of term.relations) { add(term.id, relation.target, relation.type); add(relation.target, term.id, relation.type); }
  }
  return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
}
const optionsSchema = z.object({ scheme: z.string().optional(), set: z.string().optional(), around: z.string().optional(),
  depth: z.number().int().min(0).max(5).default(1), types: z.array(z.enum(graphTypes)).min(1).max(4).default([...graphTypes]), at: z.number().int().nonnegative().optional() });
export function conceptGraph(store: Store, input: z.input<typeof optionsSchema> = {}) {
  const options = optionsSchema.parse(input), version = options.at ?? store.version;
  const schemes = store.schemes(version);
  if (options.scheme && !schemes.some(scheme => scheme.id === options.scheme)) throw new DomainError(404, 'Scheme not found at this version.');
  let concepts = store.terms(options.scheme, version).filter(term => term.status !== 'retired');
  if (options.set) {
    const expanded = store.expandSet(options.set, version);
    if (options.scheme && expanded.set.scheme !== options.scheme) throw new DomainError(422, 'The set belongs to a different scheme.');
    const ids = new Set(expanded.terms.map(term => term.id)); concepts = concepts.filter(term => ids.has(term.id));
  }
  const edges = graphEdges(concepts).filter(edge => options.types.includes(edge.type));
  if (options.around) {
    const centre = store.lookup(options.around, version);
    if (!concepts.some(term => term.id === centre.id)) throw new DomainError(422, 'The focus concept is outside the active graph selection.');
    const visited = new Set([centre.id]), adjacency = new Map<string, string[]>();
    edges.forEach(edge => adjacency.set(edge.from, [...adjacency.get(edge.from) ?? [], edge.to]));
    let frontier = [centre.id];
    for (let depth = 0; depth < options.depth; depth++) {
      const next: string[] = [];
      for (const id of frontier) for (const target of adjacency.get(id) ?? []) if (!visited.has(target)) { visited.add(target); next.push(target); }
      frontier = next;
    }
    concepts = concepts.filter(term => visited.has(term.id));
  }
  const ids = new Set(concepts.map(term => term.id));
  return { format: 'terminology-graph/1' as const, version, schemes: schemes.filter(scheme => !options.scheme || scheme.id === options.scheme),
    concepts, relations: edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}
