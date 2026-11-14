import { DomainError, type TermView } from './model.js';

const segment = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** `scheme:slug`, or `scheme:a/b/slug` naming each broader term's slug down to the term. */
const keyPattern = new RegExp(`^([a-z][a-z0-9-]{0,59}):(${segment}(?:/${segment})*)$`);

export type Resolution = {
  term: TermView;
  via: 'id' | 'alias' | 'slug';
  /** False when a slug in the reference is one the term had before. */
  current?: boolean;
  /** The term the reference names as `scheme:slug`, when an alias for another term took precedence. */
  shadowed?: { id: string; label: string; key: string };
};

/**
 * Concept keys at one version: `scheme:slug`, as quote-mcp and essay sources name concepts. A slug that repeats in a
 * scheme (slugs unique only among siblings or at some depths) is narrowed by the slugs of its broader terms,
 * `scheme:parent/slug`. Current and former slugs both match.
 */
export class TermKeys {
  private readonly bySlug = new Map<string, TermView[]>();
  private readonly byId: Map<string, TermView>;
  private readonly aliases = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  constructor(private readonly terms: TermView[]) {
    this.byId = new Map(terms.map(term => [term.id, term]));
    for (const term of terms) {
      for (const value of new Set([term.slug, ...term.formerSlugs].filter(Boolean))) {
        const index = `${term.scheme}|${value}`;
        this.bySlug.set(index, [...this.bySlug.get(index) ?? [], term]);
      }
      // Terms are sorted as lookup sees them, so the first owner of an alias is the one it resolves to.
      for (const alias of term.aliases) if (!this.aliases.has(alias)) this.aliases.set(alias, term.id);
    }
  }
  /** Terms a `scheme:slug` or `scheme:a/b/slug` reference names; null when the reference has neither form. */
  match(ref: string): TermView[] | null {
    return this.matchPath(ref)?.map(item => item.term) ?? null;
  }
  /** As match, with whether some matching path uses only current slugs (false when it needs a former one). */
  private matchPath(ref: string): { term: TermView; current: boolean }[] | null {
    const parsed = keyPattern.exec(ref);
    if (!parsed) return null;
    const [, scheme, path] = parsed;
    let found = new Map<string, { term: TermView; current: boolean }>();
    path.split('/').forEach((value, i) => {
      const next = new Map<string, { term: TermView; current: boolean }>();
      for (const term of this.bySlug.get(`${scheme}|${value}`) ?? []) {
        const parents = i === 0 ? [{ current: true }] : term.broader.flatMap(id => found.has(id) ? [found.get(id)!] : []);
        if (parents.length) next.set(term.id, { term, current: term.slug === value && parents.some(parent => parent.current) });
      }
      found = next;
    });
    return [...found.values()];
  }
  /**
   * The shortest `scheme:…slug` that resolves to this term, or its stable ID when none does. Paths through every
   * broader term are tried, one level at a time, in the order of each term's broader list.
   */
  key(term: TermView): string {
    const saved = this.keys.get(term.id);
    if (saved) return saved;
    let key = term.id;
    // Each path is the slugs from an ancestor down to the term; a graph scheme can have many, so each level is capped.
    let paths: { slugs: string[]; top: TermView; ids: Set<string> }[] = term.slug ? [{ slugs: [term.slug], top: term, ids: new Set([term.id]) }] : [];
    while (paths.length && key === term.id) {
      const hit = paths.find(path => {
        const candidate = `${term.scheme}:${path.slugs.join('/')}`, owner = this.aliases.get(candidate), found = this.match(candidate)!;
        return (owner === undefined || owner === term.id) && found.length === 1 && found[0].id === term.id;
      });
      if (hit) key = `${term.scheme}:${hit.slugs.join('/')}`;
      paths = paths.flatMap(path => path.top.broader.flatMap(id => {
        const parent = this.byId.get(id);
        return parent?.slug && !path.ids.has(parent.id) ? [{ slugs: [parent.slug, ...path.slugs], top: parent, ids: new Set([...path.ids, parent.id]) }] : [];
      })).slice(0, 256);
    }
    this.keys.set(term.id, key);
    return key;
  }
  /** Stable ID, then exact alias, then `scheme:slug`; an earlier kind of reference that matches decides. */
  resolve(ref: string): Resolution {
    const byId = this.byId.get(ref);
    if (byId) return { term: byId, via: 'id' };
    const matched = this.matchPath(ref), found = matched?.map(item => item.term), owner = this.aliases.get(ref);
    if (owner) {
      const other = found?.length === 1 && found[0].id !== owner ? found[0] : undefined;
      return { term: this.byId.get(owner)!, via: 'alias', ...other ? { shadowed: { id: other.id, label: other.label, key: this.key(other) } } : {} };
    }
    if (matched?.length === 1) return { term: matched[0].term, via: 'slug', current: matched[0].current };
    if (found && found.length > 1)
      throw new DomainError(409, `${ref} names ${found.length} terms. Use one of their keys, which add the broader term's slug.`, {
        reason: 'ambiguous-slug', candidates: found.map(term => ({ id: term.id, key: this.key(term), label: term.label, status: term.status,
          ...term.path ? { path: `${term.scheme}:${term.path}` } : {}, broader: term.broader.map(id => this.byId.get(id)?.label ?? id) })) });
    throw new DomainError(404, 'Term not found at this version.');
  }
}

/** A sentence for a reference that resolved in a way the caller should know about, or undefined. */
export function notice(ref: string, resolution: Resolution): { ref: string; message: string } | undefined {
  if (resolution.shadowed) return { ref, message: `${ref} is an alias of ${resolution.term.label} (${resolution.term.id}), which takes precedence; `
    + `as a scheme:slug it would name ${resolution.shadowed.label}, reachable as ${resolution.shadowed.key}.` };
  if (resolution.current === false) return { ref, message: `${ref} uses a former slug of ${resolution.term.label} or of a broader term; its current key is given in key.` };
  return undefined;
}
