import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTermSchema, editTermSchema, schemeSchema, operationSchema, importPlanSchema, DomainError,
  type Scheme, type Term, type TermView, type Change } from './model.js';

const slug = (label: string) => label.normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-|-$/g, '') || 'term';

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
    if (version > 1) throw new Error('This database was created by a newer application version.');
    if (version === 1) return;
    this.db.transaction(() => {
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
    })();
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
    return (this.db.prepare('SELECT body FROM schemes WHERE created <= ? ORDER BY id')
      .all(this.atVersion(at)) as { body: string }[]).map(row => JSON.parse(row.body));
  }
  private scheme(id: string): Scheme {
    const row = this.db.prepare('SELECT body FROM schemes WHERE id = ?').get(id) as { body: string } | undefined;
    if (!row) throw new DomainError(404, 'Scheme not found.');
    return JSON.parse(row.body);
  }
  addScheme(input: unknown): Scheme {
    const data = schemeSchema.parse(input);
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM schemes WHERE id = ?').get(data.id))
        throw new DomainError(409, 'That scheme ID already exists.');
      if (data.sourceUri && this.schemes().some(scheme => scheme.sourceUri === data.sourceUri))
        throw new DomainError(409, 'That source scheme is already imported.');
      const n = this.version + 1;
      const scheme = { ...data, created: n };
      this.db.prepare('INSERT INTO schemes VALUES (?, ?, ?)').run(scheme.id, n, JSON.stringify(scheme));
      this.log({ kind: 'scheme-added', terms: [], before: null, after: scheme, breaking: false, reason: '' });
      return scheme;
    })();
  }
  private rawTerms(at?: number): Term[] {
    const version = this.atVersion(at);
    return (this.db.prepare(`SELECT r.body FROM term_revisions r
      JOIN (SELECT term_id, MAX(n) AS n FROM term_revisions WHERE n <= ? GROUP BY term_id) latest
      ON r.term_id = latest.term_id AND r.n = latest.n`).all(version) as { body: string }[])
      .map(row => ({ replacedBy: [], ...JSON.parse(row.body) }));
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
  changes(since = 0, term?: string): Change[] {
    this.atVersion(since);
    return (this.db.prepare('SELECT body FROM changes WHERE n > ? ORDER BY n').all(since) as { body: string }[])
      .map(row => JSON.parse(row.body) as Change).filter(change => !term || change.terms.includes(term));
  }
  private log(data: Omit<Change, 'n' | 'at' | 'author'>): number {
    const change: Change = { ...data, n: this.version + 1, at: new Date().toISOString(), author: 'local-editor' };
    this.db.prepare('INSERT INTO changes(n, body) VALUES (?, ?)').run(change.n, JSON.stringify(change));
    return change.n;
  }
  private validateTerm(term: Term) {
    this.validateAll([...this.rawTerms().filter(other => other.id !== term.id), term]);
  }
  private validateAll(terms: Term[]) {
    const byId = new Map(terms.map(term => [term.id, term]));
    const schemes = new Map(this.schemes().map(scheme => [scheme.id, scheme]));
    const siblings = new Set<string>();
    for (const term of terms) {
      editTermSchema.parse({ label: term.label, altLabels: term.altLabels, scopeNote: term.scopeNote,
        status: term.status === 'retired' ? 'active' : term.status, relations: term.relations,
        links: term.links, expectedChanged: Math.max(1, term.changed) });
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
      if (siblings.has(key)) throw new DomainError(409, `A sibling already uses the path label “${term.label}”.`);
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
      const term: Term = { ...data, replacedBy: [], altLabels: [...new Set(data.altLabels)], id: `t_${randomUUID().replaceAll('-', '')}`, created: n, changed: n };
      this.validateTerm(term);
      const alias = this.pathAlias(term);
      term.aliases = [...new Set([...term.aliases, ...(term.sourceUri ? [term.sourceUri] : []), ...(alias ? [alias] : [])])];
      this.log({ kind: 'added', terms: [term.id], before: null, after: term, breaking: false, reason: '' });
      this.persist(term, n);
      return this.lookup(term.id);
    })();
  }
  editTerm(id: string, input: unknown): TermView {
    const data = editTermSchema.parse(input);
    return this.db.transaction(() => {
      const { path: _path, depth: _depth, narrower: _narrower, ...before } = this.lookup(id);
      if (before.status === 'retired') throw new DomainError(422, 'Retired terms are read-only.');
      if (before.id !== id) throw new DomainError(400, 'Use the stable term ID for edits.');
      if (before.changed !== data.expectedChanged)
        throw new DomainError(409, 'This term changed since you opened it. Reload it before saving.');
      const { expectedChanged: _expected, reason, ...fields } = data;
      const term: Term = { ...before, ...fields, altLabels: [...new Set(fields.altLabels)], changed: this.version + 1 };
      this.validateTerm(term);
      const renamed = before.label !== term.label;
      const removedRelation = before.relations.some(old => !term.relations.some(r => r.type === old.type && r.target === old.target));
      const comparable = (value: Term) => JSON.stringify({ label: value.label, altLabels: value.altLabels,
        scopeNote: value.scopeNote, status: value.status, relations: value.relations, links: value.links });
      if (comparable(before) === comparable(term)) return this.lookup(id);
      const onlyNote = comparable({ ...term, scopeNote: before.scopeNote }) === comparable(before);
      return this.commitTerms([...this.rawTerms().filter(other => other.id !== id), term],
        renamed ? 'labelled' : onlyNote ? 'noted' : 'updated', reason, id, renamed || removedRelation).term;
    })();
  }
  private commitTerms(candidates: Term[], kind: Change['kind'], reason: string, primary: string, breaking: boolean) {
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
      afterTerms: changed, breaking, reason });
    for (const term of changed) this.persist(term, n);
    const views = new Map(this.terms().map(term => [term.id, term]));
    return { version: n, term: views.get(primary)!,
      affected: changed.map(term => ({ before: old.get(term.id) ?? null, after: views.get(term.id)! })),
      usage: 'unknown' as const };
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
      const terms: Term[] = plan.terms.map(({ key, ...term }) => ({ ...term, id: ids.get(key)!, scheme: scheme.id,
        sourceUri: key, broader: term.broader.map(key => resolve(key)),
        relations: term.relations.map(relation => ({ ...relation, target: resolve(relation.target, true) })),
        replacedBy: term.replacedBy.map(key => resolve(key)), created: n, changed: n }));
      const result = this.commitTerms([...before, ...terms], 'imported', `Imported scheme ${scheme.label}`, terms[0].id, false);
      return { ...result, scheme, count: terms.length };
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
      const children = terms.filter(term => term.broader.includes(id));
      let replacements: Term[] = [];
      if (operation.kind === 'move') {
        source.broader = operation.broader;
      } else {
        if (operation.kind === 'split') {
          replacements = operation.newTerms.map(term => ({ ...source, ...term,
            id: `t_${randomUUID().replaceAll('-', '')}`, aliases: [], sourceUri: undefined,
            altLabels: [], links: [], replacedBy: [], created: this.version + 1, changed: this.version + 1 }));
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
            target.altLabels = [...new Set([...target.altLabels, source.label, ...source.altLabels])].filter(label => label !== target.label);
            target.links = [...new Map([...target.links, ...source.links].map(link => [`${link.match}:${link.uri}`, link])).values()];
          }
        }
        source.status = 'retired'; source.replacedBy = replacements.map(term => term.id); source.relations = [];
        for (const term of terms) term.relations = [...new Map(term.relations.map(relation => [`${relation.type}:${relation.target}`, relation])).values()];
      }
      const kinds = { move: 'moved', merge: 'merged', split: 'split', retire: 'retired' } as const;
      return this.commitTerms(terms, kinds[operation.kind], operation.reason, id, true);
    })();
  }
}
