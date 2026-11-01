import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTermSchema, editTermSchema, schemeSchema, operationSchema, importPlanSchema, uniqueNotations, DomainError,
  conceptSetSchema, pathLabel as slug, slugify, slugSchema, proposeTermSchema, schemeSettingsSchema, progressSchema,
  type ConceptSet, type Scheme, type Term, type TermView, type Change, type Subscriber } from './model.js';

const setReferences = (set: Pick<ConceptSet, 'members' | 'recipe'>) => [...set.members,
  ...set.recipe?.concepts ?? [], ...set.recipe?.narrower ?? [], ...set.recipe?.exclude ?? [], ...set.recipe?.around.map(rule => rule.term) ?? []];

export class Store {
  readonly db: Database.Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }
  close() { this.db.close(); }
  preview<T>(work: () => T): T {
    class Result { constructor(readonly value: T) {} }
    try { this.db.transaction(() => { throw new Result(work()); })(); }
    catch (error) { if (error instanceof Result) return error.value; throw error; }
    throw new Error('Unreachable preview result.');
  }
  private expectVersion(expected: number) {
    if (!Number.isSafeInteger(expected) || expected !== this.version)
      throw new DomainError(409, 'The workspace changed. Generate a new preview before applying.');
  }
  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 4) throw new Error('This database was created by a newer application version.');
    if (version === 4) return;
    this.db.transaction(() => {
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE schemes (id TEXT PRIMARY KEY, created INTEGER NOT NULL, body TEXT NOT NULL);
          CREATE TABLE terms (id TEXT PRIMARY KEY, scheme TEXT NOT NULL REFERENCES schemes(id), body TEXT NOT NULL);
          CREATE INDEX terms_scheme ON terms(scheme);
          CREATE TABLE aliases (alias TEXT PRIMARY KEY, term_id TEXT NOT NULL REFERENCES terms(id));
          CREATE TABLE changes (n INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
          CREATE TABLE term_revisions (
            term_id TEXT NOT NULL REFERENCES terms(id), n INTEGER NOT NULL REFERENCES changes(n),
            body TEXT NOT NULL, PRIMARY KEY (term_id, n));
          CREATE INDEX term_revisions_version ON term_revisions(n);
          PRAGMA user_version = 1;
        `);
      }
      if (version < 2) this.db.exec(`CREATE TABLE concept_sets (id TEXT PRIMARY KEY, scheme TEXT NOT NULL REFERENCES schemes(id), body TEXT NOT NULL);
        CREATE TABLE set_revisions (set_id TEXT NOT NULL REFERENCES concept_sets(id), n INTEGER NOT NULL REFERENCES changes(n),
          body TEXT NOT NULL, PRIMARY KEY (set_id, n));
        CREATE INDEX set_revisions_version ON set_revisions(n);
        PRAGMA user_version = 2;`);
      // Scheme settings can change from v4, so scheme reads become versioned like terms and sets.
      this.db.exec(`CREATE TABLE scheme_revisions (scheme_id TEXT NOT NULL REFERENCES schemes(id), n INTEGER NOT NULL REFERENCES changes(n),
          body TEXT NOT NULL, PRIMARY KEY (scheme_id, n));
        INSERT INTO scheme_revisions SELECT id, created, body FROM schemes;
        CREATE TABLE subscribers (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
      if (version < 3) {
        this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('log', randomUUID());
        this.backfillSlugs();
      }
      this.db.exec('PRAGMA user_version = 4');
    })();
  }
  private backfillSlugs() {
    // Slugs are minted once at creation, so earlier revisions and change snapshots carry the same slug.
    // Mint from each term's creation revision, so a rename before the upgrade does not change the slug, and
    // reserve it in both its creation-time and current scopes so the current state stays valid.
    const current = this.rawTerms().sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    const first = new Map((this.db.prepare(`SELECT term_id, body FROM term_revisions r
      WHERE n = (SELECT MIN(n) FROM term_revisions WHERE term_id = r.term_id)`).all() as { term_id: string; body: string }[])
      .map(row => [row.term_id, JSON.parse(row.body) as Term]));
    const created = current.map(term => ({ ...term, slug: '', label: first.get(term.id)?.label ?? term.label, broader: first.get(term.id)?.broader ?? term.broader }));
    const then = this.slugScopes(created), now = this.slugScopes(current);
    this.mintSlugs(created, new Map(current.map(term => [term.id, [...new Set([...then.get(term.id)!, ...now.get(term.id)!])]])));
    const slugs = new Map(created.map(term => [term.id, term.slug]));
    const fill = (value: unknown) => {
      const item = value as Partial<Term> | null;
      if (item?.id && item.scheme && slugs.has(item.id) && !item.slug) Object.assign(item, { slug: slugs.get(item.id), formerSlugs: item.formerSlugs ?? [] });
      return item;
    };
    for (const table of ['terms', 'term_revisions'] as const) {
      const rows = this.db.prepare(`SELECT rowid AS row, body FROM ${table}`).all() as { row: number; body: string }[];
      for (const row of rows) this.db.prepare(`UPDATE ${table} SET body = ? WHERE rowid = ?`).run(JSON.stringify(fill(JSON.parse(row.body))), row.row);
    }
    for (const row of this.db.prepare('SELECT n, body FROM changes').all() as { n: number; body: string }[]) {
      const change = JSON.parse(row.body) as Change;
      [change.before, change.after, ...change.beforeTerms ?? [], ...change.afterTerms ?? []].forEach(fill);
      this.db.prepare('UPDATE changes SET body = ? WHERE n = ?').run(JSON.stringify(change), row.n);
    }
  }
  /** Identifies this changelog; a rebuilt store starts a new log, so saved cursors no longer apply. */
  get logId(): string {
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'log'").get() as { value: string }).value;
  }
  get version(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM changes').get() as { n: number }).n;
  }
  private atVersion(at = this.version): number {
    if (!Number.isSafeInteger(at) || at < 0 || at > this.version)
      throw new DomainError(400, 'Version must be between 0 and the current changelog number.');
    return at;
  }
  schemes(at?: number): Scheme[] {
    return (this.db.prepare(`SELECT r.body FROM scheme_revisions r
      JOIN (SELECT scheme_id, MAX(n) AS n FROM scheme_revisions WHERE n <= ? GROUP BY scheme_id) latest
      ON r.scheme_id = latest.scheme_id AND r.n = latest.n ORDER BY r.scheme_id`)
      .all(this.atVersion(at)) as { body: string }[]).map(row => ({ notations: [], slugUniqueDepths: [], ...JSON.parse(row.body) }));
  }
  sets(scheme?: string, at?: number): ConceptSet[] {
    return (this.db.prepare(`SELECT r.body FROM set_revisions r JOIN
      (SELECT set_id, MAX(n) AS n FROM set_revisions WHERE n <= ? GROUP BY set_id) latest
      ON r.set_id = latest.set_id AND r.n = latest.n`).all(this.atVersion(at)) as { body: string }[])
      .map(row => JSON.parse(row.body) as ConceptSet).filter(set => !set.deleted && (!scheme || set.scheme === scheme))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
  conceptSet(id: string, at?: number): ConceptSet {
    const set = this.sets(undefined, at).find(set => set.id === id);
    if (!set) throw new DomainError(404, 'Concept set not found at this version.');
    return set;
  }
  termCollections(id: string, at?: number) {
    const version = this.atVersion(at), term = this.lookup(id, version);
    const sets = this.sets(term.scheme, version), byId = new Map(sets.map(set => [set.id, set])), cache = new Map<string, boolean>();
    const included = (id: string): boolean => {
      if (!cache.has(id)) {
        const set = byId.get(id)!;
        cache.set(id, set.recipe ? this.expandSet(id, version).terms.some(member => member.id === term.id)
          : set.members.includes(term.id) || set.members.some(member => byId.has(member) && included(member)));
      }
      return cache.get(id)!;
    };
    return { version, collections: sets.map(set => ({
      id: set.id, label: set.label, direct: !set.recipe && set.members.includes(term.id), recipe: !!set.recipe,
      included: included(set.id), inherited: !set.recipe && set.members.some(id => byId.has(id) && included(id)),
    })) };
  }
  private collectionSourceUris(): Map<string, string> {
    // Tombstones retain their source identity even though normal set reads hide them.
    const sets = (this.db.prepare('SELECT body FROM concept_sets').all() as { body: string }[])
      .map(row => JSON.parse(row.body) as ConceptSet);
    return new Map(sets.flatMap(set => set.sourceUri ? [[set.sourceUri, set.id] as const] : []));
  }
  private validateSets(sets: ConceptSet[], terms = this.rawTerms()) {
    const byId = new Map([...terms, ...sets].map(item => [item.id, item]));
    const slugs = new Set<string>(), sources = new Set<string>();
    const reserved = this.collectionSourceUris();
    for (const set of sets) {
      this.scheme(set.scheme);
      if (set.recipe && (set.members.length || set.ordered)) throw new DomainError(422, 'Recipe sets cannot have explicit members or ordering.');
      const key = `${set.scheme}:${set.slug}`;
      if (slugs.has(key)) throw new DomainError(409, 'Set slugs must be unique within a scheme.');
      slugs.add(key);
      if (set.sourceUri) {
        if ((reserved.has(set.sourceUri) && reserved.get(set.sourceUri) !== set.id) || sources.has(set.sourceUri) ||
            terms.some(term => term.sourceUri === set.sourceUri || term.aliases.includes(set.sourceUri!)) || this.schemes().some(s => s.sourceUri === set.sourceUri))
          throw new DomainError(409, 'That source IRI is already in use.');
        sources.add(set.sourceUri);
      }
      if (new Set(set.members).size !== set.members.length) throw new DomainError(422, 'Collection members must be distinct.');
      const recipeRefs = set.recipe ? [...set.recipe.concepts, ...set.recipe.narrower, ...set.recipe.exclude, ...set.recipe.around.map(rule => rule.term)] : [];
      for (const member of [...set.members, ...recipeRefs]) {
        const target = byId.get(member);
        if (!target || target.scheme !== set.scheme) throw new DomainError(422, 'Members must be existing terms or sets in the same scheme.');
        if (recipeRefs.includes(member) && !terms.some(term => term.id === member)) throw new DomainError(422, 'Recipe rules must refer to terms.');
      }
    }
    const depths = new Map<string, number>(), setMap = new Map(sets.map(set => [set.id, set]));
    const visit = (id: string, path: Set<string>): number => {
      if (path.has(id)) throw new DomainError(422, 'Nested collections must not contain cycles.');
      const saved = depths.get(id);
      if (saved !== undefined) return saved;
      const set = setMap.get(id);
      const depth = set ? 1 + Math.max(0, ...set.members.map(member => visit(member, new Set([...path, id])))) : 0;
      if (depth > 40) throw new DomainError(422, 'Nested collections are limited to 40 levels.');
      depths.set(id, depth);
      return depth;
    };
    for (const set of sets) visit(set.id, new Set());
  }
  private persistSet(set: ConceptSet) {
    this.db.prepare('INSERT INTO concept_sets VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body')
      .run(set.id, set.scheme, JSON.stringify(set));
    this.db.prepare('INSERT INTO set_revisions VALUES (?, ?, ?)').run(set.id, set.changed, JSON.stringify(set));
  }
  saveSet(input: unknown, expectedVersion: number, id?: string): ConceptSet {
    const fields = conceptSetSchema.parse(input);
    return this.db.transaction(() => {
      this.expectVersion(expectedVersion);
      const before = id ? this.conceptSet(id) : null;
      if (before && (before.scheme !== fields.scheme || before.sourceUri !== fields.sourceUri))
        throw new DomainError(422, 'A set’s scheme and source IRI cannot be changed.');
      const set: ConceptSet = { ...fields, id: before?.id ?? `s_${randomUUID().replaceAll('-', '')}`,
        created: before?.created ?? this.version + 1, changed: this.version + 1 };
      this.validateSets([...this.sets().filter(other => other.id !== set.id), set]);
      const breaking = !!before && (before.label !== set.label || before.members.some(member => !set.members.includes(member)) ||
        before.ordered !== set.ordered || JSON.stringify(before.recipe) !== JSON.stringify(set.recipe) || (set.ordered && JSON.stringify(before.members) !== JSON.stringify(set.members)));
      this.log({ kind: before ? 'set-changed' : 'set-added', terms: [...new Set([...(before ? setReferences(before) : []), ...setReferences(set)])].filter(id => id.startsWith('t_')),
        before, after: set, beforeSets: before ? [before] : [], afterSets: [set], breaking, reason: '' });
      this.persistSet(set);
      return set;
    })();
  }
  deleteSet(id: string, expectedVersion: number) {
    return this.db.transaction(() => {
      this.expectVersion(expectedVersion);
      const before = this.conceptSet(id);
      if (this.sets().some(set => set.members.includes(id))) throw new DomainError(422, 'Remove this set from its parent collections first.');
      const after = { ...before, deleted: true, changed: this.version + 1 };
      this.log({ kind: 'set-deleted', terms: [...new Set(setReferences(before))].filter(id => id.startsWith('t_')), before, after,
        beforeSets: [before], afterSets: [after], breaking: true, reason: '' });
      this.persistSet(after);
      return { version: this.version };
    })();
  }
  expandSet(id: string, at?: number) {
    const version = this.atVersion(at), set = this.conceptSet(id, version);
    const sets = new Map(this.sets(undefined, version).map(set => [set.id, set]));
    const terms = new Map(this.terms(undefined, version).map(term => [term.id, term]));
    const result = new Map<string, TermView>(), visited = new Set<string>();
    const warnings = new Set<string>();
    const recipeTerms = (set: ConceptSet): string[] => {
      const recipe = set.recipe!;
      const included = new Set(recipe.concepts);
      const children = new Map<string, string[]>(), neighbours = new Map<string, { type: string; id: string }[]>();
      for (const term of terms.values()) if (term.scheme === set.scheme && term.status !== 'retired') {
        for (const parent of term.broader) {
          children.set(parent, [...children.get(parent) ?? [], term.id]);
          neighbours.set(term.id, [...neighbours.get(term.id) ?? [], { type: 'broader', id: parent }]);
          neighbours.set(parent, [...neighbours.get(parent) ?? [], { type: 'narrower', id: term.id }]);
        }
        for (const relation of term.relations) {
          if (terms.get(relation.target)?.scheme !== set.scheme || terms.get(relation.target)?.status === 'retired') continue;
          neighbours.set(term.id, [...neighbours.get(term.id) ?? [], { type: relation.type, id: relation.target }]);
          neighbours.set(relation.target, [...neighbours.get(relation.target) ?? [], { type: relation.type, id: term.id }]);
        }
      }
      const valid = (id: string) => {
        const term = terms.get(id);
        if (term?.status === 'retired') { warnings.add(`Retired recipe reference retained for review: ${term.label}`); return false; }
        return !!term;
      };
      for (const id of [...recipe.concepts, ...recipe.narrower, ...recipe.exclude, ...recipe.around.map(rule => rule.term)]) valid(id);
      for (const root of recipe.narrower) if (valid(root)) {
        const queue = [...children.get(root) ?? []], seen = new Set<string>();
        for (let i = 0; i < queue.length; i++) {
          const id = queue[i]; if (seen.has(id)) continue; seen.add(id); included.add(id); queue.push(...children.get(id) ?? []);
        }
      }
      for (const rule of recipe.around) if (valid(rule.term)) {
        const seen = new Set([rule.term]); let frontier = [rule.term]; included.add(rule.term);
        for (let depth = 0; depth < rule.depth; depth++) {
          const next: string[] = [];
          for (const id of frontier) for (const edge of neighbours.get(id) ?? []) if (rule.types.some(type => type === edge.type) && !seen.has(edge.id)) {
            seen.add(edge.id); included.add(edge.id); next.push(edge.id);
          }
          frontier = next;
        }
      }
      return [...included].filter(id => !recipe.exclude.includes(id) && terms.get(id)?.status !== 'retired');
    };
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const nested = sets.get(id);
      if (nested) (nested.recipe ? recipeTerms(nested) : nested.members).forEach(visit);
      else if (terms.has(id)) result.set(id, terms.get(id)!);
    };
    (set.recipe ? recipeTerms(set) : set.members).forEach(visit);
    const members = [...result.values()];
    if (!set.ordered) members.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    return { set, version, terms: members, warnings: [...warnings, ...members.filter(term => term.status === 'retired')
      .map(term => `Retired member retained for review: ${term.label}`)] };
  }
  private scheme(id: string): Scheme {
    const row = this.db.prepare('SELECT body FROM schemes WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) throw new DomainError(404, 'Scheme not found.');
    return { notations: [], slugUniqueDepths: [], ...JSON.parse(row.body) };
  }
  addScheme(input: unknown): Scheme {
    const data = schemeSchema.parse(input);
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schemes WHERE id = ?').get(data.id))
        throw new DomainError(409, 'That scheme ID already exists.');
      if (data.sourceUri && this.schemes().some(scheme => scheme.sourceUri === data.sourceUri))
        throw new DomainError(409, 'That source scheme is already imported.');
      if (data.sourceUri && this.collectionSourceUris().has(data.sourceUri))
        throw new DomainError(409, 'A collection IRI cannot also identify a scheme.');
      if (data.slugUniqueDepths.length && data.hierarchy !== 'tree')
        throw new DomainError(422, 'Scheme-wide slug depths apply only to tree schemes.');
      const n = this.version + 1;
      const scheme = { ...data, notations: uniqueNotations(data.notations),
        slugUniqueDepths: [...new Set(data.slugUniqueDepths)].sort((a, b) => a - b), created: n };
      this.log({ kind: 'scheme-added', terms: [], before: null, after: scheme, breaking: false, reason: '' });
      this.db.prepare('INSERT INTO schemes VALUES (?, ?, ?)').run(scheme.id, n, JSON.stringify(scheme));
      this.db.prepare('INSERT INTO scheme_revisions VALUES (?, ?, ?)').run(scheme.id, n, JSON.stringify(scheme));
      return scheme;
    })();
  }
  /** Changes a scheme's settings. Only the maximum depth is editable; existing terms must already fit it. */
  updateScheme(id: string, input: unknown): Scheme {
    const data = schemeSettingsSchema.parse(input);
    return this.db.transaction(() => {
      this.expectVersion(data.expectedVersion);
      const before = this.scheme(id);
      const { maxDepth: _old, ...rest } = before;
      const after: Scheme = data.maxDepth === null ? rest : { ...rest, maxDepth: data.maxDepth };
      if (after.maxDepth === before.maxDepth) return before;
      this.checkDepths(this.rawTerms(), new Map(this.schemes().map(scheme => [scheme.id, scheme.id === id ? after : scheme])));
      const n = this.log({ kind: 'scheme-changed', terms: [], before, after, breaking: false,
        reason: after.maxDepth === undefined ? 'Removed the maximum depth' : `Maximum depth ${after.maxDepth}` });
      this.db.prepare('UPDATE schemes SET body = ? WHERE id = ?').run(JSON.stringify(after), id);
      this.db.prepare('INSERT INTO scheme_revisions VALUES (?, ?, ?)').run(id, n, JSON.stringify(after));
      return after;
    })();
  }
  private rawTerms(at?: number): Term[] {
    const version = this.atVersion(at);
    return (this.db.prepare(`SELECT r.body FROM term_revisions r
      JOIN (SELECT term_id, MAX(n) AS n FROM term_revisions WHERE n <= ? GROUP BY term_id) latest
      ON r.term_id = latest.term_id AND r.n = latest.n`).all(version) as { body: string }[])
      .map(row => ({ replacedBy: [], notations: [], formerSlugs: [], ...JSON.parse(row.body) }));
  }
  private views(terms: Term[]): TermView[] {
    const byId = new Map(terms.map(term => [term.id, term]));
    const schemes = new Map(this.schemes().map(scheme => [scheme.id, scheme]));
    const cache = new Map<string, { path: string | null; depth: number }>();
    const derive = (term: Term): { path: string | null; depth: number } => {
      const saved = cache.get(term.id);
      if (saved) return saved;
      const parents = term.broader.map(id => derive(byId.get(id)!));
      const value = {
        path: schemes.get(term.scheme)?.hierarchy === 'tree'
          ? `${parents[0]?.path ? parents[0].path + '/' : ''}${slug(term.label)}` : null,
        depth: parents.length ? Math.min(...parents.map(parent => parent.depth)) + 1 : 0,
      };
      cache.set(term.id, value);
      return value;
    };
    const children = new Map<string, string[]>();
    for (const term of terms) for (const parent of term.broader)
      children.set(parent, [...(children.get(parent) ?? []), term.id]);
    return terms.map(term => ({ ...term, ...derive(term), narrower: children.get(term.id) ?? [] }));
  }
  terms(scheme?: string, at?: number): TermView[] {
    const terms = this.views(this.rawTerms(at));
    return terms.filter(term => !scheme || term.scheme === scheme)
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
  lookup(ref: string, at?: number): TermView {
    // Resolve against the historical term bodies, never today's alias index.
    const term = this.terms(undefined, at).find(term => term.id === ref || term.aliases.includes(ref));
    if (!term) throw new DomainError(404, 'Term not found at this version.');
    return term;
  }
  /** Resolves a current or former slug within a scheme; `parent` (an ID, alias or slug) or `depth` narrows the match. */
  slugLookup(scheme: string, value: string, filter: { parent?: string; depth?: number } = {}, at?: number): { version: number; term: TermView; current: boolean } {
    const { parent, depth } = filter;
    const version = this.atVersion(at);
    if (!this.schemes(version).some(item => item.id === scheme)) throw new DomainError(404, 'Scheme not found at this version.');
    const terms = this.terms(scheme, version);
    let matches = terms.filter(term => term.slug === value || term.formerSlugs.includes(value));
    if (parent !== undefined) {
      // A parent slug may itself repeat across depths, so every term it names is a candidate parent.
      const owners = new Set(terms.filter(term => term.id === parent || term.aliases.includes(parent) ||
        term.slug === parent || term.formerSlugs.includes(parent)).map(term => term.id));
      if (!owners.size) throw new DomainError(404, 'No parent term has that ID, alias or slug at this version.');
      matches = matches.filter(term => term.broader.some(id => owners.has(id)));
    }
    if (depth !== undefined) matches = matches.filter(term => term.depth === depth);
    if (!matches.length) throw new DomainError(404, 'No term has that slug at this version.');
    if (matches.length > 1) throw new DomainError(409, 'That slug names several terms; pass a parent or depth to choose one.');
    return { version, term: matches[0], current: matches[0].slug === value };
  }
  changes(since = 0, term?: string, scheme?: string): Change[] {
    return this.changesIn(since, scheme ? [scheme] : [], term);
  }
  /** Changes after `since` touching any of `schemes` (all changes when empty). */
  private changesIn(since: number, schemes: string[], term?: string): Change[] {
    this.atVersion(since);
    const known = new Set(this.schemes().map(item => item.id));
    if (schemes.some(id => !known.has(id))) throw new DomainError(404, 'Scheme not found.');
    const wanted = new Set(schemes);
    const inScheme = (change: Change) => [change.before, change.after, ...change.beforeTerms ?? [], ...change.afterTerms ?? [],
      ...change.beforeSets ?? [], ...change.afterSets ?? []].some(item => item && wanted.has('scheme' in item ? item.scheme : item.id));
    return (this.db.prepare('SELECT body FROM changes WHERE n > ? ORDER BY n').all(since) as { body: string }[])
      .map(row => JSON.parse(row.body) as Change).filter(change => (!term || change.terms.includes(term)) && (!wanted.size || inScheme(change)));
  }
  private log(data: Omit<Change, 'n' | 'at' | 'author'> & { author?: string }): number {
    const change: Change = { author: 'local-editor', ...data, n: this.version + 1, at: new Date().toISOString() };
    this.db.prepare('INSERT INTO changes(n, body) VALUES (?, ?)').run(change.n, JSON.stringify(change));
    return change.n;
  }
  private validateTerm(term: Term) {
    this.validateAll([...this.rawTerms().filter(other => other.id !== term.id), term]);
  }
  private validateAll(terms: Term[]) {
    const byId = new Map(terms.map(term => [term.id, term]));
    const collectionUris = this.collectionSourceUris();
    const schemes = new Map(this.schemes().map(scheme => [scheme.id, scheme]));
    const siblings = new Set<string>();
    for (const term of terms) {
      if ((term.sourceUri && collectionUris.has(term.sourceUri)) || term.aliases.some(alias => collectionUris.has(alias)))
        throw new DomainError(409, 'A collection IRI cannot also identify a concept.');
      editTermSchema.parse({ label: term.label, altLabels: term.altLabels, scopeNote: term.scopeNote,
        status: term.status === 'retired' ? 'active' : term.status, relations: term.relations,
        links: term.links, notations: term.notations, expectedChanged: Math.max(1, term.changed) });
      const scheme = schemes.get(term.scheme);
      if (!scheme) throw new DomainError(404, 'Scheme not found.');
      if (scheme.hierarchy === 'tree' && term.broader.length > 1)
        throw new DomainError(422, 'A tree term can have only one broader term.');
      if (new Set(term.broader).size !== term.broader.length) throw new DomainError(422, 'Broader terms must be distinct.');
      for (const id of term.broader) {
        const parent = byId.get(id);
        if (!parent) throw new DomainError(422, 'Broader term not found.');
        if (parent.scheme !== term.scheme) throw new DomainError(422, 'Broader terms must be in the same scheme.');
        if (term.status !== 'retired' && parent.status === 'retired') throw new DomainError(422, 'An active term cannot have a retired broader term.');
      }
      const keys = new Set<string>();
      for (const relation of term.relations) {
        if (relation.target === term.id) throw new DomainError(422, 'A term cannot relate to itself.');
        const target = byId.get(relation.target);
        if (!target) throw new DomainError(422, 'Relation target not found.');
        if (target.status === 'retired') throw new DomainError(422, 'Relation targets must not be retired.');
        if (relation.type !== 'related' && target.scheme !== term.scheme) throw new DomainError(422, 'Only related relations may cross schemes.');
        const key = `${relation.type}:${relation.target}`;
        if (keys.has(key)) throw new DomainError(422, 'Duplicate relation.');
        keys.add(key);
      }
      for (const replacement of term.replacedBy) {
        const target = byId.get(replacement);
        if (!target || target.id === term.id || target.scheme !== term.scheme)
          throw new DomainError(422, 'Replacements must be other terms in the same scheme.');
      }
      const key = `${term.scheme}:${[...term.broader].sort().join(',')}:${slug(term.label)}`;
      if (scheme.hierarchy !== 'graph' && siblings.has(key)) throw new DomainError(409, `A sibling already uses the path label “${term.label}”.`);
      siblings.add(key);
    }
    const checkCycles = (edges: (term: Term) => string[], name: string) => {
      const depths = new Map<string, number>(), visiting = new Set<string>();
      const visit = (id: string): number => {
        if (visiting.has(id)) throw new DomainError(422, `${name} would contain a cycle.`);
        const cached = depths.get(id);
        if (cached !== undefined) return cached;
        if (visiting.size > 500) throw new DomainError(422, `${name} exceeds the supported depth of 500.`);
        visiting.add(id);
        let depth = 0;
        for (const parent of edges(byId.get(id)!)) depth = Math.max(depth, visit(parent) + 1);
        if (depth > 500) throw new DomainError(422, `${name} exceeds the supported depth of 500.`);
        visiting.delete(id); depths.set(id, depth);
        return depth;
      };
      terms.forEach(term => visit(term.id));
    };
    checkCycles(term => term.broader, 'Hierarchy');
    checkCycles(term => term.replacedBy, 'Replacement chain');
    this.checkDepths(terms, schemes);
    this.validateSlugs(terms);
  }
  /** Rejects active and provisional terms deeper than their scheme's maximum depth (top terms are depth 0). */
  private checkDepths(terms: Term[], schemes: Map<string, Scheme>) {
    if (![...schemes.values()].some(scheme => scheme.maxDepth !== undefined)) return;
    const views = this.views(terms);
    for (const term of views) {
      const limit = schemes.get(term.scheme)?.maxDepth;
      if (limit !== undefined && term.status !== 'retired' && term.depth > limit)
        throw new DomainError(422, `“${term.label}” would be at depth ${term.depth}, but ${schemes.get(term.scheme)!.label} allows terms only to depth ${limit} (top terms are depth 0).`);
    }
  }
  private slugScopes(terms: Term[]): Map<string, string[]> {
    // Slugs are unique among siblings, and scheme-wide at the scheme's listed depths. Retired terms keep their scope.
    const byId = new Map(terms.map(term => [term.id, term])), schemes = new Map(this.schemes().map(scheme => [scheme.id, scheme]));
    const depths = new Map<string, number>(), visiting = new Set<string>();
    const depth = (term: Term): number => {
      const saved = depths.get(term.id);
      if (saved !== undefined) return saved;
      if (visiting.has(term.id)) return 0;
      visiting.add(term.id);
      const parents = term.broader.flatMap(id => byId.has(id) ? [depth(byId.get(id)!)] : []);
      visiting.delete(term.id);
      const value = parents.length ? Math.min(...parents) + 1 : 0;
      depths.set(term.id, value);
      return value;
    };
    return new Map(terms.map(term => {
      const siblings = term.broader.length ? term.broader.map(parent => `${term.scheme}|in:${parent}`) : [`${term.scheme}|top`];
      const wide = schemes.get(term.scheme)?.slugUniqueDepths.includes(depth(term)) ? [`${term.scheme}|depth:${depth(term)}`] : [];
      return [term.id, [...siblings, ...wide]];
    }));
  }
  /** Gives each term without a slug one from its label, suffixed -2, -3, … within its scopes. Mutates the terms. */
  private mintSlugs(terms: Term[], scopes = this.slugScopes(terms)) {
    const pending = terms.filter(term => !term.slug);
    if (!pending.length) return;
    const taken = new Set<string>();
    const reserve = (term: Term) => scopes.get(term.id)!.forEach(scope => [term.slug, ...term.formerSlugs].forEach(value => taken.add(`${scope}|${value}`)));
    terms.filter(term => term.slug).forEach(reserve);
    for (const term of pending) {
      const base = slugify(term.label), free = (value: string) => scopes.get(term.id)!.every(scope => !taken.has(`${scope}|${value}`));
      let value = base;
      for (let i = 2; !free(value); i++) value = `${base.slice(0, 79 - String(i).length).replace(/-+$/, '')}-${i}`;
      term.slug = value; reserve(term);
    }
  }
  private validateSlugs(terms: Term[]) {
    const scopes = this.slugScopes(terms), owners = new Map<string, string>();
    for (const term of terms) {
      if (![term.slug, ...term.formerSlugs].every(value => slugSchema.safeParse(value).success))
        throw new DomainError(422, `Invalid slug for “${term.label}”: use lowercase letters and digits separated by single hyphens.`);
      if (term.formerSlugs.includes(term.slug) || new Set(term.formerSlugs).size !== term.formerSlugs.length)
        throw new DomainError(422, 'Former slugs must be distinct from each other and from the current slug.');
      for (const scope of scopes.get(term.id)!) for (const value of [term.slug, ...term.formerSlugs]) {
        const key = `${scope}|${value}`, owner = owners.get(key);
        if (owner && owner !== term.id)
          throw new DomainError(409, `The slug “${value}” is already used ${scope.includes('|depth:') ? 'at this depth of the scheme' : 'by a sibling term'}.`);
        owners.set(key, term.id);
      }
    }
  }
  private persist(term: Term, n: number) {
    this.db.prepare(`INSERT INTO terms VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`)
      .run(term.id, term.scheme, JSON.stringify(term));
    this.db.prepare('INSERT INTO term_revisions VALUES (?, ?, ?)').run(term.id, n, JSON.stringify(term));
    for (const alias of term.aliases) {
      const owner = this.db.prepare('SELECT term_id FROM aliases WHERE alias = ?').get(alias) as { term_id: string } | undefined;
      if (owner && owner.term_id !== term.id) throw new DomainError(409, `Alias “${alias}” belongs to another term.`);
      if (this.db.prepare('SELECT id FROM terms WHERE id = ? AND id != ?').get(alias, term.id))
        throw new DomainError(409, 'An alias cannot shadow a term ID.');
      this.db.prepare('INSERT OR IGNORE INTO aliases VALUES (?, ?)').run(alias, term.id);
    }
  }
  private pathAlias(term: Term): string | null {
    if (this.scheme(term.scheme).hierarchy !== 'tree') return null;
    const parentPath = term.broader.length ? this.lookup(term.broader[0]).path + '/' : '';
    return `${term.scheme}:${parentPath}${slug(term.label)}`;
  }
  addTerm(input: unknown): TermView {
    const data = createTermSchema.parse(input);
    return this.db.transaction(() => {
      const n = this.version + 1;
      const term: Term = { ...data, slug: data.slug ?? '', formerSlugs: [], notations: uniqueNotations(data.notations), replacedBy: [], altLabels: [...new Set(data.altLabels)], id: `t_${randomUUID().replaceAll('-', '')}`, created: n, changed: n };
      this.mintSlugs([...this.rawTerms(), term]);
      this.validateTerm(term);
      const alias = this.pathAlias(term);
      term.aliases = [...new Set([...term.aliases, ...(term.sourceUri ? [term.sourceUri] : []), ...(alias ? [alias] : [])])];
      this.log({ kind: 'added', terms: [term.id], before: null, after: term, breaking: false, reason: '' });
      this.persist(term, n);
      return this.lookup(term.id);
    })();
  }
  /**
   * Creates a provisional term on behalf of a consumer or agent. A retry with the same proposer and requestId
   * returns the original term; a sibling (or scheme-wide peer) with the same slug or path label is a 409.
   */
  propose(input: unknown, identity?: string) {
    const data = proposeTermSchema.parse(input);
    const proposer = identity ?? data.proposer;
    if (!proposer) throw new DomainError(422, 'Name the proposer.');
    return this.db.transaction(() => {
      const terms = this.rawTerms();
      const prior = data.requestId && terms.find(term => term.proposal?.proposer === proposer && term.proposal.requestId === data.requestId);
      if (prior) return { ...this.proposalResult(prior), replayed: true };
      this.scheme(data.scheme);
      const parent = this.resolveRef(data.scheme, data.broader);
      if (parent.status === 'retired') throw new DomainError(422, 'Propose terms under an active or provisional term.');
      const n = this.version + 1;
      const term: Term = { scheme: data.scheme, label: data.label, altLabels: [...new Set(data.altLabels)], scopeNote: data.scopeNote,
        broader: [parent.id], notations: [], relations: [], links: [], aliases: [], status: 'provisional', replacedBy: [],
        slug: data.slug ?? slugify(data.label), formerSlugs: [], id: `t_${randomUUID().replaceAll('-', '')}`, created: n, changed: n,
        proposal: { proposer, ...(data.evidence ? { evidence: data.evidence } : {}), ...(data.requestId ? { requestId: data.requestId } : {}) } };
      const scopes = this.slugScopes([...terms, term]), mine = new Set(scopes.get(term.id));
      const clashes = terms.filter(other => other.scheme === term.scheme && (
        (other.broader.includes(parent.id) && slug(other.label) === slug(term.label)) ||
        ([other.slug, ...other.formerSlugs].includes(term.slug) && scopes.get(other.id)!.some(scope => mine.has(scope)))))
        .sort((a, b) => Number(a.status === 'retired') - Number(b.status === 'retired'));
      if (clashes.length) {
        const existing = clashes[0], retired = existing.status === 'retired';
        throw new DomainError(409, retired
          ? `A retired term, “${existing.label}”, already uses that slug or label here. Use its replacement or propose a different slug.`
          : `“${existing.label}” already uses that slug or label here. Use it, or propose a different slug.`,
        { reason: retired ? 'retired' : 'duplicate', existing: { id: existing.id, slug: existing.slug, label: existing.label,
          status: existing.status, replacedBy: existing.replacedBy } });
      }
      this.validateTerm(term);
      const alias = this.pathAlias(term);
      if (alias) term.aliases = [alias];
      this.log({ kind: 'added', terms: [term.id], before: null, after: term, breaking: false, reason: `Proposed by ${proposer}`,
        author: proposer, proposal: term.proposal });
      this.persist(term, n);
      return { ...this.proposalResult(term), replayed: false };
    })();
  }
  private proposalResult(term: Term) {
    const view = this.lookup(term.id);
    return { id: view.id, slug: view.slug, status: view.status, change: term.created, version: this.version, term: view };
  }
  /** Resolves a term reference within a scheme: a stable ID, an alias, or a current or former slug. */
  private resolveRef(scheme: string, ref: string): TermView {
    let term: TermView;
    try { term = this.lookup(ref); }
    catch (error) {
      if (!(error instanceof DomainError) || error.status !== 404) throw error;
      term = this.slugLookup(scheme, ref).term;
    }
    if (term.scheme !== scheme) throw new DomainError(422, 'The broader term must be in the same scheme.');
    return term;
  }
  /** Records how far a subscriber has applied the changelog. The first report registers it. */
  reportProgress(id: string, input: unknown) {
    if (!/^[a-z][a-z0-9-]{0,59}$/.test(id)) throw new DomainError(422, 'Subscriber IDs use lowercase letters, digits and hyphens.');
    const data = progressSchema.parse(input);
    return this.db.transaction(() => {
      if (data.log !== this.logId)
        throw new DomainError(409, 'This store has a different log ID. Bootstrap again from /api/state.', { log: this.logId });
      if (data.through > this.version) throw new DomainError(400, 'Progress cannot be beyond the current changelog number.');
      if (data.blocked && (data.blocked.at <= data.through || data.blocked.at > this.version))
        throw new DomainError(422, 'A blocking change must be after the reported progress and no later than the head.');
      const known = new Set(this.schemes().map(scheme => scheme.id));
      if (data.schemes?.some(scheme => !known.has(scheme))) throw new DomainError(404, 'Scheme not found.');
      const row = this.db.prepare('SELECT body FROM subscribers WHERE id = ?').get(id) as { body: string } | undefined;
      const prior = row ? JSON.parse(row.body) as Subscriber : undefined;
      if (prior && data.through < prior.through && !data.reset)
        throw new DomainError(409, 'Progress cannot move backwards. Send reset: true after bootstrapping again.', { through: prior.through });
      const now = new Date().toISOString();
      const subscriber: Subscriber = { id, label: data.label ?? prior?.label ?? id, schemes: data.schemes ?? prior?.schemes ?? [],
        log: data.log, through: data.through, blocked: data.blocked ? { ...data.blocked } : null, lastSeen: now, registered: prior?.registered ?? now };
      this.db.prepare('INSERT INTO subscribers VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(id, JSON.stringify(subscriber));
      return this.subscriberView(subscriber);
    })();
  }
  subscribers() {
    return (this.db.prepare('SELECT body FROM subscribers ORDER BY id').all() as { body: string }[])
      .map(row => this.subscriberView(JSON.parse(row.body) as Subscriber));
  }
  subscriber(id: string) {
    const row = this.db.prepare('SELECT body FROM subscribers WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) throw new DomainError(404, 'Subscriber not found.');
    return this.subscriberView(JSON.parse(row.body) as Subscriber);
  }
  private subscriberView(subscriber: Subscriber) {
    const pending = this.changesIn(Math.min(subscriber.through, this.version), subscriber.schemes.filter(id => this.schemes().some(s => s.id === id)));
    return { ...subscriber, head: this.version, pending: pending.length, pendingBreaking: pending.filter(change => change.breaking).length,
      pendingTerms: [...new Set(pending.flatMap(change => change.terms))] };
  }
  editTerm(id: string, input: unknown): TermView {
    const data = editTermSchema.parse(input);
    return this.db.transaction(() => {
      const { path: _path, depth: _depth, narrower: _narrower, ...before } = this.lookup(id);
      if (before.status === 'retired') throw new DomainError(422, 'Retired terms are read-only.');
      if (before.id !== id) throw new DomainError(400, 'Use the stable term ID for edits.');
      if (before.changed !== data.expectedChanged)
        throw new DomainError(409, 'This term changed since you opened it. Reload it before saving.');
      const { expectedChanged: _expected, reason, collections, expectedVersion, ...fields } = data;
      const setChanges: ConceptSet[] = [];
      if (expectedVersion !== undefined) this.expectVersion(expectedVersion);
      if (collections !== undefined) {
        if (expectedVersion === undefined) throw new DomainError(422, 'Collection edits require the expected workspace version.');
        if (new Set(collections).size !== collections.length) throw new DomainError(422, 'Collection assignments must be distinct.');
        const sets = this.sets(), selected = new Set(collections);
        for (const id of selected) {
          const set = sets.find(set => set.id === id);
          if (!set || set.scheme !== before.scheme || set.recipe) throw new DomainError(422, 'Choose explicit collections in this term’s scheme; recipe membership is calculated.');
        }
        for (const set of sets.filter(set => set.scheme === before.scheme && !set.recipe)) {
          const has = set.members.includes(id), wanted = selected.has(set.id);
          if (has === wanted) continue;
          const members = wanted ? [...set.members, id] : set.members.filter(member => member !== id);
          if (members.length > 10000) throw new DomainError(422, 'Collections are limited to 10,000 members.');
          setChanges.push({ ...set, members, changed: this.version + 1 });
        }
        this.validateSets([...sets.filter(set => !setChanges.some(changed => changed.id === set.id)), ...setChanges]);
      }
      const term: Term = { ...before, ...fields, notations: uniqueNotations(fields.notations ?? before.notations), altLabels: [...new Set(fields.altLabels)], changed: this.version + 1 };
      this.validateTerm(term);
      const renamed = before.label !== term.label;
      const removedRelation = before.relations.some(old => !term.relations.some(r => r.type === old.type && r.target === old.target));
      const comparable = (value: Term) => JSON.stringify({ label: value.label, altLabels: value.altLabels,
        scopeNote: value.scopeNote, status: value.status, relations: value.relations, links: value.links, notations: value.notations });
      const fieldsChanged = comparable(before) !== comparable(term);
      if (!fieldsChanged && !setChanges.length) return this.lookup(id);
      const onlyNote = comparable({ ...term, scopeNote: before.scopeNote }) === comparable(before);
      const removed = before.relations.filter(old => !term.relations.some(r => r.type === old.type && r.target === old.target));
      const candidates = this.rawTerms().filter(other => other.id !== id).map(other => ({ ...other,
        relations: other.relations.filter(r => !removed.some(old => old.target === other.id && old.type === r.type && r.target === id)),
      }));
      return this.commitTerms([...candidates, term],
        !fieldsChanged ? 'set-changed' : renamed ? 'labelled' : onlyNote ? 'noted' : 'updated', reason, id,
        renamed || removedRelation || setChanges.some(set => !set.members.includes(id)), setChanges).term;
    })();
  }
  private commitTerms(candidates: Term[], kind: Change['kind'], reason: string, primary: string, breaking: boolean, setChanges: ConceptSet[] = []) {
    this.validateAll(candidates);
    const before = this.rawTerms();
    const old = new Map(before.map(term => [term.id, term]));
    const oldViews = new Map(this.views(before).map(term => [term.id, term]));
    const n = this.version + 1;
    const candidateViews = new Map(this.views(candidates).map(term => [term.id, term]));
    const after = [...candidateViews.values()].map(({ path, depth: _depth, narrower: _narrower, ...term }) => ({
      ...term, aliases: [...new Set([...term.aliases, ...(term.sourceUri ? [term.sourceUri] : []), ...(path ? [`${term.scheme}:${path}`] : [])])],
    }));
    const changed = after.filter(term => JSON.stringify(term) !== JSON.stringify(old.get(term.id)) ||
      oldViews.get(term.id)?.path !== candidateViews.get(term.id)?.path ||
      oldViews.get(term.id)?.depth !== candidateViews.get(term.id)?.depth)
      .map(term => ({ ...term, changed: n }));
    if (!changed.length) throw new DomainError(422, 'This operation would not change any terms.');
    const primaryAfter = changed.find(term => term.id === primary) ?? changed[0];
    this.log({ kind, terms: changed.map(term => term.id), before: old.get(primary) ?? null,
      after: primaryAfter, beforeTerms: changed.flatMap(term => old.has(term.id) ? [old.get(term.id)!] : []),
      afterTerms: changed, breaking, reason,
      ...(setChanges.length ? { beforeSets: setChanges.map(set => this.conceptSet(set.id)), afterSets: setChanges } : {}) });
    for (const term of changed) this.persist(term, n);
    for (const set of setChanges) this.persistSet(set);
    const views = new Map(this.terms().map(term => [term.id, term]));
    return { version: n, term: views.get(primary)!,
      affected: changed.map(term => ({ before: old.get(term.id) ?? null, after: views.get(term.id)! })),
      usage: 'unknown' as const };
  }
  setRelation(source: string, target: string, type: 'related' | 'opposite', enabled: boolean, expectedVersion: number) {
    return this.db.transaction(() => {
      this.expectVersion(expectedVersion);
      const terms = this.rawTerms(), from = terms.find(term => term.id === source), to = terms.find(term => term.id === target);
      if (!from || !to) throw new DomainError(404, 'Relation endpoint not found.');
      if (from.status === 'retired' || to.status === 'retired') throw new DomainError(422, 'Retired concepts are read-only.');
      if (from.id === to.id) throw new DomainError(422, 'A concept cannot relate to itself.');
      let changed = false;
      for (const [term, other] of [[from, to], [to, from]]) {
        const exists = term.relations.some(r => r.target === other.id && r.type === type);
        if (enabled && !exists) { term.relations.push({ type, target: other.id }); changed = true; }
        if (!enabled && exists) { term.relations = term.relations.filter(r => r.target !== other.id || r.type !== type); changed = true; }
      }
      if (!changed) return { version: this.version, term: this.lookup(source), affected: [], usage: 'unknown' as const };
      return this.commitTerms(terms, 'updated', `${enabled ? 'Added' : 'Removed'} ${type} relationship`, source, !enabled);
    })();
  }
  importScheme(input: unknown, expectedVersion: number) {
    const plan = importPlanSchema.parse(input);
    return this.db.transaction(() => {
      this.expectVersion(expectedVersion);
      if (new Set(plan.terms.map(term => term.key)).size !== plan.terms.length)
        throw new DomainError(422, 'Duplicate concept IRIs in import.');
      const before = this.rawTerms();
      for (const term of plan.terms) {
        if (before.some(existing => existing.sourceUri === term.key || existing.aliases.includes(term.key)))
          throw new DomainError(409, `The source concept is already imported: ${term.key}`);
      }
      const scheme = this.addScheme(plan.scheme);
      const ids = new Map(plan.terms.map(term => [term.key, `t_${randomUUID().replaceAll('-', '')}`]));
      const resolve = (key: string, external = false): string => {
        const id = ids.get(key);
        if (id) return id;
        if (external) {
          const term = before.find(term => term.sourceUri === key || term.aliases.includes(key));
          if (term) return term.id;
        }
        throw new DomainError(422, `Unresolved concept reference: ${key}`);
      };
      const n = this.version + 1;
      const terms: Term[] = plan.terms.map(({ key, ...term }) => ({ ...term, slug: term.slug ?? '', notations: uniqueNotations(term.notations), id: ids.get(key)!, scheme: scheme.id,
        sourceUri: key, broader: term.broader.map(key => resolve(key)),
        relations: term.relations.map(relation => ({ ...relation, target: resolve(relation.target, true) })),
        replacedBy: term.replacedBy.map(key => resolve(key)), created: n, changed: n }));
      this.mintSlugs([...before, ...terms]);
      const result = this.commitTerms([...before, ...terms], 'imported', `Imported scheme ${scheme.label}`, terms[0].id, false);
      if (new Set(plan.sets.map(set => set.key)).size !== plan.sets.length || plan.sets.some(set => ids.has(set.key) || set.key === plan.scheme.sourceUri))
        throw new DomainError(422, 'Collection IRIs must be distinct from concepts and schemes.');
      const setIds = new Map(plan.sets.map(set => [set.key, `s_${randomUUID().replaceAll('-', '')}`]));
      const sets: ConceptSet[] = plan.sets.map(({ key, ...set }) => ({ ...set, scheme: scheme.id, sourceUri: key,
        id: setIds.get(key)!, members: set.members.map(key => setIds.get(key) ?? resolve(key)),
        ...(set.recipe ? { recipe: { concepts: set.recipe.concepts.map(key => resolve(key)), narrower: set.recipe.narrower.map(key => resolve(key)),
          exclude: set.recipe.exclude.map(key => resolve(key)), around: set.recipe.around.map(rule => ({ ...rule, term: resolve(rule.term) })) } } : {}),
        created: this.version + 1, changed: this.version + 1 }));
      if (sets.length) {
        this.validateSets([...this.sets(), ...sets]);
        this.log({ kind: 'set-added', terms: terms.map(term => term.id), before: null, after: sets[0],
          beforeSets: [], afterSets: sets, breaking: false, reason: `Imported ${sets.length} collections` });
        sets.forEach(set => this.persistSet(set));
      }
      return { ...result, version: this.version, scheme, count: terms.length, sets };
    })();
  }
  operate(id: string, input: unknown) {
    const operation = operationSchema.parse(input);
    return this.db.transaction(() => {
      this.expectVersion(operation.expectedVersion);
      const terms = structuredClone(this.rawTerms());
      const byId = new Map(terms.map(term => [term.id, term]));
      const source = byId.get(id);
      if (!source) throw new DomainError(404, 'Term not found.');
      if (source.status === 'retired') throw new DomainError(422, 'Retired terms are read-only.');
      const beforeExpansions = new Map(this.sets().map(set => [set.id, this.expandSet(set.id)]));
      const children = terms.filter(term => term.broader.includes(id));
      let replacements: Term[] = [];
      if (operation.kind === 'move') {
        source.broader = operation.broader;
      } else if (operation.kind === 'slug') {
        if (operation.slug === source.slug) throw new DomainError(422, 'That is already this term’s slug.');
        // The old slug stays reserved in the term's scopes so existing references resolve while consumers migrate.
        source.formerSlugs = [...source.formerSlugs.filter(value => value !== operation.slug), source.slug];
        source.slug = operation.slug;
      } else {
        if (operation.kind === 'split') {
          replacements = operation.newTerms.map(term => ({ ...source, ...term,
            id: `t_${randomUUID().replaceAll('-', '')}`, aliases: [], sourceUri: undefined, slug: '', formerSlugs: [],
            altLabels: [], links: [], notations: [], replacedBy: [], created: this.version + 1, changed: this.version + 1 }));
          if (new Set(operation.children.map(child => child.id)).size !== operation.children.length ||
              operation.children.length !== children.length || children.some(child => !operation.children.some(row => row.id === child.id)))
            throw new DomainError(422, 'Assign every direct narrower term exactly once when splitting.');
          for (const assignment of operation.children) {
            if (assignment.targets.some(index => !replacements[index]) || new Set(assignment.targets).size !== assignment.targets.length)
              throw new DomainError(422, 'Invalid split assignment.');
            const child = byId.get(assignment.id)!;
            child.broader = [...new Set([...child.broader.filter(parent => parent !== id), ...assignment.targets.map(index => replacements[index].id)])];
          }
          terms.push(...replacements);
          replacements.forEach(term => byId.set(term.id, term));
        } else {
          const replacementIds = operation.kind === 'merge' ? [operation.target] : operation.replacements;
          if (new Set(replacementIds).size !== replacementIds.length) throw new DomainError(422, 'Replacement terms must be distinct.');
          replacements = replacementIds.map(targetId => {
            const target = byId.get(targetId);
            if (!target || target.id === id || target.scheme !== source.scheme || target.status === 'retired')
              throw new DomainError(422, 'Choose an active replacement in the same scheme.');
            const descendant = (term: Term, seen = new Set<string>()): boolean => {
              if (term.broader.includes(id)) return true;
              if (seen.has(term.id)) return false;
              seen.add(term.id); return term.broader.some(parent => descendant(byId.get(parent)!, seen));
            };
            if (descendant(target)) throw new DomainError(422, 'A replacement cannot be a descendant of the retiring term.');
            return target;
          });
          // Merge moves children to the target. Retirement promotes children
          // to the source's former broader terms, independently of replacements.
          for (const child of children) child.broader = [...new Set([...child.broader.filter(parent => parent !== id),
            ...(operation.kind === 'merge' ? replacements.map(term => term.id) : source.broader)])];
        }
        const inherited = structuredClone(source.relations);
        for (const term of terms) {
          term.relations = term.relations.flatMap(relation => relation.target === id
            ? replacements.filter(target => target.id !== term.id).map(target => ({ ...relation, target: target.id })) : [relation]);
        }
        for (const target of replacements) {
          target.relations.push(...inherited.filter(relation => relation.target !== target.id));
          if (operation.kind === 'merge') {
            target.notations = uniqueNotations([...target.notations, ...source.notations]);
            target.altLabels = [...new Set([...target.altLabels, source.label, ...source.altLabels])].filter(label => label !== target.label);
            target.links = [...new Map([...target.links, ...source.links].map(link => [`${link.match}:${link.uri}`, link])).values()];
          }
        }
        source.status = 'retired'; source.replacedBy = replacements.map(term => term.id); source.relations = [];
        for (const term of terms) term.relations = [...new Map(term.relations.map(relation => [`${relation.type}:${relation.target}`, relation])).values()];
      }
      const kinds = { move: 'moved', merge: 'merged', split: 'split', retire: 'retired', slug: 'slugged' } as const;
      const setChanges = operation.kind === 'merge' ? this.sets().flatMap(set => {
        const replace = (ids: string[]) => [...new Set(ids.map(member => member === id ? operation.target : member))];
        const after = { ...set, members: replace(set.members), ...(set.recipe ? { recipe: {
          concepts: replace(set.recipe.concepts), narrower: replace(set.recipe.narrower), exclude: replace(set.recipe.exclude),
          around: set.recipe.around.map(rule => ({ ...rule, term: rule.term === id ? operation.target : rule.term })),
        } } : {}) };
        return JSON.stringify(after) === JSON.stringify(set) ? [] : [{ ...after, changed: this.version + 1 }];
      }) : [];
      this.mintSlugs(terms);
      const result = this.commitTerms(terms, kinds[operation.kind], operation.reason, id, true, setChanges);
      return { ...result, affectedSets: this.sets().flatMap(set => {
        const before = beforeExpansions.get(set.id)!, after = this.expandSet(set.id);
        const beforeIds = before.terms.map(term => term.id), afterIds = after.terms.map(term => term.id);
        const content = (value: typeof before) => JSON.stringify({ set: value.set, terms: value.terms.map(term => ({
          id: term.id, status: term.status, replacedBy: term.replacedBy, path: term.path, depth: term.depth,
        })), warnings: value.warnings });
        if (!beforeIds.includes(id) && !afterIds.includes(id) && content(before) === content(after)) return [];
        return [{ id: set.id, label: set.label, before: beforeIds, after: afterIds,
          note: operation.kind === 'merge' ? 'Merged references follow the target; duplicates are removed.' : operation.kind === 'move'
            ? 'Explicit membership is unchanged; recipes expand against the updated hierarchy.' : operation.kind === 'slug'
            ? 'Membership is unchanged; references by slug should follow the new slug.'
            : 'Retired references are retained for review; recipes omit retired terms and replacements are not automatically added.',
        }];
      }) };
    })();
  }
}
