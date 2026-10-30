import { pathLabel, type ImportPlan } from './model.js';
export const structures = ['tree', 'poly', 'graph'] as const;
export type Structure = typeof structures[number];
export type ImportMode = Structure | 'auto';

export function analyseStructure(plan: ImportPlan, requested: ImportMode, declared?: string, graphSource = false) {
  const terms = plan.terms, byKey = new Map(terms.map(term => [term.key, term]));
  const multi = terms.filter(term => new Set(term.broader).size > 1), collisions: string[] = [], siblings = new Map<string, string>();
  const connected = new Set<string>(), associative = new Set<string>();
  for (const term of terms) {
    const key = `${[...new Set(term.broader)].sort().join('|')}|${pathLabel(term.label)}`;
    const previous = siblings.get(key);
    if (previous) collisions.push(`“${previous}” and “${term.label}” have the same path label among siblings.`);
    else siblings.set(key, term.label);
    for (const parent of term.broader) { connected.add(term.key); connected.add(parent); }
    for (const relation of term.relations) {
      connected.add(term.key); connected.add(relation.target);
      associative.add(`${relation.type}:${[term.key, relation.target].sort().join('|')}`);
    }
  }
  const common: string[] = [], depths = new Map<string, number>(), visiting = new Set<string>();
  const visit = (key: string): number => {
    if (visiting.has(key)) throw new Error(`Broader/narrower cycle involving “${byKey.get(key)?.label ?? key}”.`);
    const cached = depths.get(key); if (cached !== undefined) return cached;
    if (visiting.size > 500) throw new Error('Broader/narrower hierarchy exceeds the supported depth of 500.');
    const term = byKey.get(key); if (!term) throw new Error(`Broader concept is outside the imported scheme: ${key}`);
    visiting.add(key); let depth = 0;
    for (const parent of term.broader) depth = Math.max(depth, visit(parent) + 1);
    if (depth > 500) throw new Error('Broader/narrower hierarchy exceeds the supported depth of 500.');
    visiting.delete(key); depths.set(key, depth); return depth;
  };
  try { terms.forEach(term => visit(term.key)); } catch (error) { common.push((error as Error).message); }
  const examples = multi.slice(0, 5).map(term => `“${term.label}” has ${new Set(term.broader).size} broader concepts: ${term.broader.map(key => byKey.get(key)?.label ?? key).join(', ')}.`);
  const reasons = {
    tree: [...common, ...(multi.length ? [`${multi.length} concept${multi.length === 1 ? ' has' : 's have'} multiple broader concepts.`, ...examples] : []), ...collisions.slice(0, 5)],
    poly: [...common, ...collisions.slice(0, 5)], graph: [...common],
  };
  const compatibility = Object.fromEntries(structures.map(type => [type, { compatible: reasons[type].length === 0, reasons: reasons[type] }])) as Record<Structure, {compatible: boolean; reasons: string[]}>;
  const validDeclared = structures.includes(declared as Structure) && compatibility[declared as Structure].compatible;
  let recommended: Structure, reason: string;
  if (validDeclared) { recommended = declared as Structure; reason = `The source declares ${declared}, and its content is compatible.`; }
  else if (graphSource || associative.size || collisions.length || !terms.some(term => term.broader.length)) {
    recommended = 'graph';
    reason = graphSource ? 'The source describes a concept network.' : associative.size ? 'Associative relationships suggest a concept graph.'
      : collisions.length ? 'Graph preserves concepts with colliding path labels.' : 'No hierarchy was detected; intent is ambiguous, so Graph is the default.';
  } else if (multi.length) { recommended = 'poly'; reason = 'The acyclic hierarchy has concepts with multiple broader concepts.'; }
  else { recommended = 'tree'; reason = 'The hierarchy is acyclic, with at most one broader concept per concept.'; }
  if (declared && !validDeclared) reason = `Source declaration “${declared}” is incompatible or unrecognized. ${reason}`;
  if (common.length) reason = 'No structure can import this hierarchy without fixing the reported problems.';
  const selected = requested === 'auto' ? recommended : requested;
  plan.scheme.hierarchy = selected;
  return { requested, declared: declared ?? null, recommended, selected, reason, compatible: compatibility[selected].compatible, compatibility,
    stats: { concepts: terms.length, broaderLinks: terms.reduce((n, term) => n + new Set(term.broader).size, 0),
      associativeLinks: associative.size, multipleParents: multi.length, roots: terms.filter(term => !term.broader.length).length,
      isolated: terms.filter(term => !connected.has(term.key)).length } };
}
