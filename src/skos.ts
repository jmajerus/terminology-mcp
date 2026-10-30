import { Parser, Writer, Store as RdfStore, DataFactory, type Quad, type Term as RdfTerm } from 'n3';
import { z } from 'zod';
import { DomainError, iriSchema, importPlanSchema, type ImportPlan } from './model.js';
import type { Store } from './store.js';

const { namedNode: nn, literal: lit, quad } = DataFactory;
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DCT = 'http://purl.org/dc/terms/';
const EX = 'urn:terminology-mcp:vocab:';
const matches = ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'] as const;
export const importRequestSchema = z.object({
  format: z.enum(['turtle', 'sparql']), data: z.string().max(5 * 1024 * 1024).optional(),
  endpoint: z.string().optional(), graph: iriSchema.optional(), sourceScheme: iriSchema,
  schemeId: z.string(), label: z.string().trim().max(200).optional(),
  hierarchy: z.enum(['tree', 'poly']), language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).default('en'),
}).strict();
export type ImportRequest = z.infer<typeof importRequestSchema>;

export function parseRdf(data: string): RdfStore {
  if (Buffer.byteLength(data) > 5 * 1024 * 1024) throw new DomainError(413, 'RDF is limited to 5 MiB.');
  try {
    const quads = new Parser({ format: 'text/turtle' }).parse(data);
    if (quads.length > 100000) throw new DomainError(413, 'RDF is limited to 100,000 triples.');
    return new RdfStore(quads);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(422, `Invalid Turtle: ${error instanceof Error ? error.message : error}`);
  }
}
export function rdfSchemes(data: string) {
  const rdf = parseRdf(data);
  return rdf.getSubjects(nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'), null)
    .filter(term => term.termType === 'NamedNode').map(term => ({ uri: term.value,
      labels: rdf.getObjects(term, nn(SKOS + 'prefLabel'), null).filter(v => v.termType === 'Literal')
        .map(v => ({ value: v.value, language: v.termType === 'Literal' ? v.language : '' })) }));
}

export function planSkos(store: Store, data: string, request: ImportRequest): { plan: ImportPlan; warnings: string[] } {
  const rdf = parseRdf(data);
  const scheme = nn(request.sourceScheme);
  if (!rdf.countQuads(scheme, nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'), null))
    throw new DomainError(422, 'The selected IRI is not a declared skos:ConceptScheme.');
  const warnings = new Set<string>();
  const objects = (s: RdfTerm, p: string) => rdf.getObjects(s, nn(p), null);
  const named = (values: RdfTerm[], field: string): string[] => values.map(value => {
    if (value.termType !== 'NamedNode') throw new DomainError(422, `${field} must use named concept IRIs, not blank nodes or literals.`);
    return iriSchema.parse(value.value);
  });
  const preferred = (subject: RdfTerm, predicate: string, required = false) => {
    const all = objects(subject, predicate);
    if (all.some(value => value.termType !== 'Literal')) throw new DomainError(422, 'Labels and notes must be literals.');
    const literals = all.filter(value => value.termType === 'Literal');
    const selected = literals.filter(value => value.language.toLowerCase() === request.language.toLowerCase());
    const plain = literals.filter(value => !value.language);
    const choices = selected.length ? selected : plain;
    if (literals.length > choices.length) warnings.add(`Labels or notes in other languages are omitted; importing ${request.language} with untagged fallback.`);
    if (required && choices.length !== 1) throw new DomainError(422, `Expected one preferred label for ${subject.value} in ${request.language} or without a language tag.`);
    if (choices.length > 1) throw new DomainError(422, `Multiple values for ${predicate} on ${subject.value}.`);
    return choices[0];
  };
  const members = new Map<string, RdfTerm>();
  const addMember = (term: RdfTerm) => { named([term], 'Concept membership'); members.set(term.value, term); };
  rdf.getSubjects(nn(SKOS + 'inScheme'), scheme, null).forEach(addMember);
  rdf.getSubjects(nn(SKOS + 'topConceptOf'), scheme, null).forEach(addMember);
  objects(scheme, SKOS + 'hasTopConcept').forEach(addMember);
  if (!members.size) throw new DomainError(422, 'The scheme has no explicit concept members.');
  for (const subject of members.values()) {
    const children = [...named(objects(subject, SKOS + 'narrower'), 'Narrower'),
      ...named(rdf.getSubjects(nn(SKOS + 'broader'), subject, null), 'Broader inverse')];
    for (const child of children) if (!members.has(child))
      throw new DomainError(422, `Narrower concept has no membership in the selected scheme: ${child}`);
  }
  const known = store.terms();
  const resolveRelated = (uri: string) => members.has(uri) || known.some(term => term.sourceUri === uri || term.aliases.includes(uri));
  const supported = new Set([RDF + 'type', SKOS + 'inScheme', SKOS + 'prefLabel', SKOS + 'altLabel', SKOS + 'scopeNote',
    SKOS + 'definition', SKOS + 'broader', SKOS + 'narrower', SKOS + 'related', SKOS + 'hasTopConcept', SKOS + 'topConceptOf',
    ...matches.map(match => SKOS + match), DCT + 'description', DCT + 'isReplacedBy', EX + 'status', EX + 'alias', EX + 'hierarchy', EX + 'admissionTest', EX + 'opposite']);
  const schemeSupported = new Set([RDF + 'type', SKOS + 'prefLabel', SKOS + 'hasTopConcept', DCT + 'description', EX + 'hierarchy', EX + 'admissionTest']);
  for (const q of rdf.getQuads(null, null, null, null)) {
    if (q.subject.equals(scheme) ? !schemeSupported.has(q.predicate.value) : members.has(q.subject.value) && !supported.has(q.predicate.value))
      warnings.add(`Unsupported predicate omitted: ${q.predicate.value}`);
    if ((q.subject.equals(scheme) || members.has(q.subject.value)) && q.predicate.value === RDF + 'type'
        && ![SKOS + 'Concept', SKOS + 'ConceptScheme'].includes(q.object.value))
      warnings.add(`Additional type declaration omitted: ${q.object.value}`);
  }
  const schemeLabel = preferred(scheme, SKOS + 'prefLabel', !request.label);
  const terms = [...members.values()].map(subject => {
    const memberships = named(objects(subject, SKOS + 'inScheme'), 'Scheme membership');
    if (memberships.some(uri => uri !== scheme.value)) throw new DomainError(422, `Concept belongs to multiple schemes: ${subject.value}`);
    const label = preferred(subject, SKOS + 'prefLabel', true)!;
    const broader = [...new Set([...named(objects(subject, SKOS + 'broader'), 'Broader'),
      ...named(rdf.getSubjects(nn(SKOS + 'narrower'), subject, null), 'Narrower inverse')])];
    for (const parent of broader) if (!members.has(parent)) throw new DomainError(422, `Broader concept is outside the selected scheme: ${parent}`);
    const relations: ImportPlan['terms'][number]['relations'] = [];
    for (const [predicate, type] of [[SKOS + 'related', 'related'], [EX + 'opposite', 'opposite']] as const) {
      const targets = [...new Set([...named(objects(subject, predicate), 'Relation'),
        ...named(rdf.getSubjects(nn(predicate), subject, null), 'Inverse relation')])];
      for (const target of targets) {
        if (resolveRelated(target)) relations.push({ type, target });
        else warnings.add(`Relation to an unimported concept omitted: ${target}`);
      }
    }
    const altLabels = objects(subject, SKOS + 'altLabel').flatMap(value => {
      if (value.termType !== 'Literal') throw new DomainError(422, 'Alternative labels must be literals.');
      if (!value.language || value.language.toLowerCase() === request.language.toLowerCase()) return [value.value];
      warnings.add(`Alternative labels in other languages omitted; importing ${request.language}.`); return [];
    });
    const statuses = objects(subject, EX + 'status');
    if (statuses.length > 1) throw new DomainError(422, `Multiple statuses for ${subject.value}.`);
    const scope = preferred(subject, SKOS + 'scopeNote') ?? preferred(subject, SKOS + 'definition');
    if (objects(subject, SKOS + 'scopeNote').length && objects(subject, SKOS + 'definition').length)
      warnings.add('skos:definition is omitted when a scope note is present.');
    return { key: subject.value, label: label.value, language: label.language || undefined,
      altLabels: [...new Set(altLabels)], scopeNote: scope?.value ?? '',
      status: (statuses[0]?.value ?? 'active') as 'active', broader, relations,
      aliases: objects(subject, EX + 'alias').map(v => {
        if (v.termType !== 'Literal') throw new DomainError(422, 'Aliases must be literals.'); return v.value;
      }),
      replacedBy: named(objects(subject, DCT + 'isReplacedBy'), 'Replacement'),
      links: matches.flatMap(match => {
        const inverse = match === 'broadMatch' ? 'narrowMatch' : match === 'narrowMatch' ? 'broadMatch' : match;
        return [...new Set([...named(objects(subject, SKOS + match), 'SKOS mapping'),
          ...named(rdf.getSubjects(nn(SKOS + inverse), subject, null), 'Inverse SKOS mapping')])].map(uri => ({ uri, match }));
      }),
    };
  });
  const plan = importPlanSchema.parse({ scheme: { id: request.schemeId,
    label: request.label || schemeLabel!.value, language: schemeLabel?.language || undefined,
    description: preferred(scheme, DCT + 'description')?.value ?? '', hierarchy: request.hierarchy,
    admissionTest: preferred(scheme, EX + 'admissionTest')?.value ?? '', sourceUri: scheme.value }, terms });
  return { plan, warnings: [...warnings] };
}

export async function exportSkos(store: Store, schemeId: string, at?: number): Promise<string> {
  const scheme = store.schemes(at).find(scheme => scheme.id === schemeId);
  if (!scheme) throw new DomainError(404, 'Scheme not found at this version.');
  const all = store.terms(undefined, at);
  const terms = all.filter(term => term.scheme === schemeId);
  const termIri = (id: string) => {
    const term = all.find(term => term.id === id);
    if (!term) throw new DomainError(422, 'Missing referenced term.');
    return nn(term.sourceUri ?? `urn:terminology-mcp:term:${term.id}`);
  };
  const subject = nn(scheme.sourceUri ?? `urn:terminology-mcp:scheme:${scheme.id}`);
  const quads: Quad[] = [];
  const add = (s: ReturnType<typeof nn>, p: string, o: ReturnType<typeof nn> | ReturnType<typeof lit>) => quads.push(quad(s, nn(p), o));
  add(subject, RDF + 'type', nn(SKOS + 'ConceptScheme'));
  add(subject, SKOS + 'prefLabel', lit(scheme.label, scheme.language));
  if (scheme.description) add(subject, DCT + 'description', lit(scheme.description, scheme.language));
  if (scheme.admissionTest) add(subject, EX + 'admissionTest', lit(scheme.admissionTest));
  add(subject, EX + 'hierarchy', lit(scheme.hierarchy));
  for (const term of terms) {
    const s = termIri(term.id);
    add(s, RDF + 'type', nn(SKOS + 'Concept'));
    add(s, SKOS + 'inScheme', subject);
    add(s, SKOS + 'prefLabel', lit(term.label, term.language));
    term.altLabels.forEach(value => add(s, SKOS + 'altLabel', lit(value, term.language)));
    if (term.scopeNote) add(s, SKOS + 'scopeNote', lit(term.scopeNote, term.language));
    term.broader.forEach(id => add(s, SKOS + 'broader', termIri(id)));
    if (!term.broader.length && term.status !== 'retired') {
      add(subject, SKOS + 'hasTopConcept', s); add(s, SKOS + 'topConceptOf', subject);
    }
    for (const relation of term.relations) add(s, relation.type === 'related' ? SKOS + 'related' : EX + 'opposite', termIri(relation.target));
    // Related is symmetric; preserve incoming cross-scheme edges in a per-scheme export.
    for (const other of all.filter(other => other.scheme !== schemeId))
      for (const relation of other.relations.filter(r => r.type === 'related' && r.target === term.id))
        add(s, SKOS + 'related', termIri(other.id));
    term.links.forEach(link => add(s, SKOS + link.match, nn(link.uri)));
    term.aliases.forEach(alias => add(s, EX + 'alias', lit(alias)));
    add(s, EX + 'status', lit(term.status));
    term.replacedBy.forEach(id => add(s, DCT + 'isReplacedBy', termIri(id)));
  }
  const writer = new Writer({ prefixes: { skos: SKOS, dct: DCT, term: EX } });
  writer.addQuads(quads);
  return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result ?? '')));
}
