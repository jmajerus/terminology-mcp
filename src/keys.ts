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
    const parsed = keyPattern.exec(ref);
    if (!parsed) return null;
    const [, scheme, path] = parsed;
    let found: TermView[] = [];
    path.split('/').forEach((value, i) => {
      const named = this.bySlug.get(`${scheme}|${value}`) ?? [];
      const parents = new Set(found.map(term => term.id));
      found = i === 0 ? named : named.filter(term => term.broader.some(id => parents.has(id)));
    });
    return found;
  }
  /** The shortest `scheme:…slug` that resolves to this term, or its stable ID when none does. */
  key(term: TermView): string {
    const saved = this.keys.get(term.id);
    if (saved) return saved;
    let key = term.id;
    if (term.slug) {
      const chain = [term.slug], seen = new Set([term.id]);
      for (let at: TermView | undefined = term; at;) {
        const candidate = `${term.scheme}:${chain.join('/')}`, owner = this.aliases.get(candidate), found = this.match(candidate)!;
        if ((owner === undefined || owner === term.id) && found.length === 1 && found[0].id === term.id) { key = candidate; break; }
        at = at.broader.map(id => this.byId.get(id)).find(parent => parent && !seen.has(parent.id) && parent.slug);
        if (at) { seen.add(at.id); chain.unshift(at.slug); }
      }
    }
    this.keys.set(term.id, key);
    return key;
  }
  /** Stable ID, then exact alias, then `scheme:slug`; an earlier kind of reference that matches decides. */
  resolve(ref: string): Resolution {
    const byId = this.byId.get(ref);
    if (byId) return { term: byId, via: 'id' };
    const found = this.match(ref), owner = this.aliases.get(ref);
    if (owner) {
      const other = found?.length === 1 && found[0].id !== owner ? found[0] : undefined;
      return { term: this.byId.get(owner)!, via: 'alias', ...other ? { shadowed: { id: other.id, label: other.label, key: this.key(other) } } : {} };
    }
    if (found?.length === 1) {
      const last = ref.slice(ref.indexOf(':') + 1).split('/').at(-1);
      return { term: found[0], via: 'slug', current: found[0].slug === last };
    }
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
  if (resolution.current === false) return { ref, message: `${ref} uses a former slug of ${resolution.term.label}; its current key is given in key.` };
  return undefined;
}
