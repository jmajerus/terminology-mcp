import { Parser, Writer, Store as RdfStore, DataFactory, type Quad, type Term as RdfTerm } from 'n3';
import { z } from 'zod';
import { RdfXmlParser } from 'rdfxml-streaming-parser';
import { DomainError, iriSchema, importPlanSchema, termIri as publicIri, type ImportPlan, type Notation } from './model.js';
import type { Store } from './store.js';
import { readCollections } from './collections.js';
import { analyseStructure } from './import-structure.js';

const { namedNode: nn, literal: lit, quad } = DataFactory;
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DCT = 'http://purl.org/dc/terms/';
const EX = 'urn:terminology-mcp:vocab:';
const maxDepth = (values: string[]) => {
  if (values.length > 1 || (values.length && !/^\d{1,3}$/.test(values[0])))
    throw new DomainError(422, 'A scheme takes at most one maximum depth, a non-negative integer.');
  return values.length ? { maxDepth: Number(values[0]) } : {};
};
// A scheme setting written as at most one plain literal from a fixed list.
const setting = <T extends string>(values: string[], allowed: readonly T[], name: string): T | undefined => {
  if (values.length > 1 || (values.length && !allowed.includes(values[0] as T)))
    throw new DomainError(422, `A scheme's ${name} is one of ${allowed.join(', ')}.`);
  return values[0] as T | undefined;
};
const matches = ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'] as const;
export const importRequestSchema = z.object({
  format: z.enum(['turtle', 'sparql', 'graph-json']), data: z.string().max(5 * 1024 * 1024).optional(),
  endpoint: z.string().optional(), graph: iriSchema.optional(), sourceScheme: iriSchema,
  schemeId: z.string(), label: z.string().trim().max(200).optional(),
  hierarchy: z.enum(['auto', 'tree', 'poly', 'graph']).default('auto'), language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).default('en'),
}).strict();
export type ImportRequest = z.infer<typeof importRequestSchema>;

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const MAX_BYTES = 5 * 1024 * 1024, MAX_TRIPLES = 100000;
const tooBig = () => new DomainError(413, `RDF is limited to ${MAX_TRIPLES.toLocaleString('en')} triples.`);

/** RDF/XML opens with an XML declaration, doctype, comment or rdf:RDF element; Turtle never does. */
// An unprefixed <RDF> root counts only with an xmlns attribute, so Turtle opening with the relative IRI <RDF> stays Turtle.
export const isRdfXml = (data: string) => /^﻿?\s*(?:<\?xml|<!DOCTYPE|<!--|<[\w.-]+:RDF[\s>/]|<RDF\s[^>]*\bxmlns\s*=)/i.test(data);

/** Parses Turtle (or N-Triples). RDF/XML needs readRdf, whose parser is asynchronous. */
export function parseRdf(data: string | RdfStore): RdfStore {
  if (typeof data !== 'string') return data;
  if (Buffer.byteLength(data) > MAX_BYTES) throw new DomainError(413, 'RDF is limited to 5 MiB.');
  if (isRdfXml(data)) throw new DomainError(422, 'RDF/XML has to be read with readRdf.');
  try {
    const quads = new Parser({ format: 'text/turtle' }).parse(data);
    if (quads.length > MAX_TRIPLES) throw tooBig();
    return new RdfStore(quads);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(422, `Invalid Turtle: ${error instanceof Error ? error.message : error}`);
  }
}

// The parser never closes its XML reader, so a file cut off inside an element would parse without complaint;
// closing it at the end of input reports the unclosed elements as an error.
class ClosingRdfXmlParser extends RdfXmlParser {
  override _flush(callback: (error?: Error | null) => void) {
    (this as unknown as { saxParser: { close(): void } }).saxParser.close();
    callback();
  }
}

/** Parses an uploaded file as RDF/XML or Turtle, telling them apart by how the file opens. */
export async function readRdf(data: string): Promise<RdfStore> {
  if (!isRdfXml(data)) return parseRdf(data);
  if (Buffer.byteLength(data) > MAX_BYTES) throw new DomainError(413, 'RDF is limited to 5 MiB.');
  const quads: Quad[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const parser = new ClosingRdfXmlParser({ dataFactory: DataFactory as never });
      parser.on('data', (q: Quad) => { quads.push(q); if (quads.length > MAX_TRIPLES) parser.destroy(tooBig()); });
      parser.on('error', reject);
      parser.on('end', resolve);
      parser.end(data);
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(422, `Invalid RDF/XML: ${error instanceof Error ? error.message : error}`);
  }
  return new RdfStore(quads);
}

/** The namespace every IRI shares (up to its last # or /), if it names more than a host. */
function sharedNamespace(iris: string[]) {
  let prefix = iris[0];
  for (const iri of iris) while (!iri.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const namespace = prefix.slice(0, Math.max(prefix.lastIndexOf('#'), prefix.lastIndexOf('/')) + 1);
  return /^[a-z][\w+.-]*:\/\/[^/#]+[/#]/i.test(namespace) ? namespace : undefined;
}

const OBO_DEFINITION = 'http://purl.obolibrary.org/obo/IAO_0000115';
const OBO_SYNONYMS = ['hasExactSynonym', 'hasRelatedSynonym', 'hasNarrowSynonym', 'hasBroadSynonym']
  .map(name => 'http://www.geneontology.org/formats/oboInOwl#' + name);
const DC_TITLE = ['http://purl.org/dc/terms/title', 'http://purl.org/dc/elements/1.1/title'];

/**
 * A file with no skos:ConceptScheme but OWL or RDFS classes, such as an OWL ontology's class hierarchy, is read as
 * one scheme: each named class becomes a concept, rdfs:subClassOf between classes becomes broader, labels, synonyms
 * and definitions carry over, and everything else is reported. The scheme is the owl:Ontology, or else the
 * namespace the classes share. Returns null when the file is already SKOS or declares no classes.
 */
export function owlAsSkos(rdf: RdfStore): { rdf: RdfStore; warnings: string[] } | null {
  if (rdf.countQuads(null, nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'), null)) return null;
  const classes = [...new Set([OWL + 'Class', RDFS + 'Class'].flatMap(type => rdf.getSubjects(nn(RDF + 'type'), nn(type), null))
    .filter(term => term.termType === 'NamedNode' && term.value !== OWL + 'Thing').map(term => term.value))];
  if (!classes.length) return null;
  const members = new Set(classes), warnings: string[] = [];
  const ontologies = rdf.getSubjects(nn(RDF + 'type'), nn(OWL + 'Ontology'), null).filter(term => term.termType === 'NamedNode');
  const schemeIri = ontologies.length === 1 ? ontologies[0].value : sharedNamespace(classes);
  if (!schemeIri) throw new DomainError(422, 'These OWL classes share no namespace to name a scheme by. Declare one owl:Ontology in the file.');
  const scheme = nn(schemeIri), out = new RdfStore();
  const literals = (subject: RdfTerm, predicates: string[]) => predicates.flatMap(p => rdf.getObjects(subject, nn(p), null))
    .filter(value => value.termType === 'Literal') as import('n3').Literal[];
  // One value per language: the first is kept, the rest returned for the caller to place or report.
  const perLanguage = (values: import('n3').Literal[]) => {
    const kept = new Map<string, import('n3').Literal>(), rest: import('n3').Literal[] = [];
    // Language tags are case-insensitive: "en" and "EN" are one language.
    for (const value of values) {
      const language = value.language.toLowerCase();
      if (kept.has(language)) rest.push(value); else kept.set(language, value);
    }
    return { kept: [...kept.values()], rest };
  };
  out.addQuad(scheme, nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'));
  const schemeLabels = ontologies.length === 1 ? perLanguage(literals(scheme, [SKOS + 'prefLabel', RDFS + 'label', ...DC_TITLE])).kept : [];
  if (ontologies.length !== 1) warnings.push(`No single owl:Ontology is declared, so the scheme is identified by the classes' namespace, ${schemeIri}.`);
  if (schemeLabels.length) schemeLabels.forEach(v => out.addQuad(scheme, nn(SKOS + 'prefLabel'), v));
  else {
    const name = decodeURIComponent(schemeIri.replace(/[/#]+$/, '').replace(/^.*[/#]/, '')) || schemeIri;
    out.addQuad(scheme, nn(SKOS + 'prefLabel'), lit(name));
    warnings.push(`The ontology has no label, so the scheme is called “${name}” unless you give it a name.`);
  }
  const used = new Set([RDF + 'type', RDFS + 'subClassOf', RDFS + 'label', RDFS + 'comment', SKOS + 'prefLabel', SKOS + 'altLabel',
    SKOS + 'definition', SKOS + 'scopeNote', SKOS + 'notation', OBO_DEFINITION, ...OBO_SYNONYMS, ...matches.map(match => SKOS + match)]);
  let restrictions = 0, outside = 0, unlabelled = 0, extraNotes = 0;
  const omitted = new Set<string>();
  for (const iri of classes) {
    const c = nn(iri);
    out.addQuad(c, nn(RDF + 'type'), nn(SKOS + 'Concept'));
    out.addQuad(c, nn(SKOS + 'inScheme'), scheme);
    const prefs = literals(c, [SKOS + 'prefLabel']);
    const labels = perLanguage(prefs.length ? prefs : literals(c, [RDFS + 'label']));
    if (!labels.kept.length) {
      unlabelled++;
      out.addQuad(c, nn(SKOS + 'prefLabel'), lit(decodeURIComponent(iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1)) || iri));
    }
    labels.kept.forEach(v => out.addQuad(c, nn(SKOS + 'prefLabel'), v));
    [...labels.rest, ...(prefs.length ? literals(c, [RDFS + 'label']) : []), ...literals(c, [SKOS + 'altLabel', ...OBO_SYNONYMS])]
      .forEach(v => out.addQuad(c, nn(SKOS + 'altLabel'), v));
    const notePredicate = [SKOS + 'scopeNote', SKOS + 'definition', OBO_DEFINITION, RDFS + 'comment'].find(p => literals(c, [p]).length);
    if (notePredicate) {
      const notes = perLanguage(literals(c, [notePredicate]));
      notes.kept.forEach(v => out.addQuad(c, nn(SKOS + 'scopeNote'), v));
      extraNotes += notes.rest.length;
    }
    for (const parent of rdf.getObjects(c, nn(RDFS + 'subClassOf'), null)) {
      if (parent.termType === 'BlankNode') restrictions++;
      else if (members.has(parent.value)) out.addQuad(c, nn(SKOS + 'broader'), parent);
      else if (parent.value !== OWL + 'Thing') outside++;
    }
    for (const match of matches) rdf.getObjects(c, nn(SKOS + match), null).forEach(v => out.addQuad(c, nn(SKOS + match), v));
    rdf.getObjects(c, nn(SKOS + 'notation'), null).forEach(v => out.addQuad(c, nn(SKOS + 'notation'), v));
    for (const q of rdf.getQuads(c, null, null, null)) if (!used.has(q.predicate.value)) omitted.add(q.predicate.value);
  }
  warnings.unshift(`Read as an OWL class hierarchy: ${classes.length} classes became concepts, and rdfs:subClassOf became broader.`);
  if (restrictions) warnings.push(`${restrictions} class restriction${restrictions === 1 ? '' : 's'} (anonymous superclasses) omitted.`);
  if (outside) warnings.push(`${outside} superclass link${outside === 1 ? '' : 's'} to classes not declared in this file omitted.`);
  if (unlabelled) warnings.push(`${unlabelled} class${unlabelled === 1 ? ' has' : 'es have'} no label and ${unlabelled === 1 ? 'is' : 'are'} named by ${unlabelled === 1 ? 'its' : 'their'} IRI's last segment.`);
  if (extraNotes) warnings.push(`${extraNotes} additional definition${extraNotes === 1 ? '' : 's'} in a language already covered omitted.`);
  omitted.forEach(p => warnings.push(`Unsupported predicate omitted: ${p}`));
  const others = new Set(rdf.getSubjects(null, null, null).filter(t => !members.has(t.value) && !t.equals(scheme) && t.termType === 'NamedNode').map(t => t.value)).size;
  if (others) warnings.push(`${others} other resource${others === 1 ? '' : 's'} (properties, individuals and the like) omitted.`);
  return { rdf: out, warnings };
}

/** The file as SKOS: as written, or read from its OWL class hierarchy (see owlAsSkos). */
function asSkos(data: string | RdfStore) {
  const rdf = parseRdf(data);
  return owlAsSkos(rdf) ?? { rdf, warnings: [] as string[] };
}

export function rdfSchemes(data: string | RdfStore) {
  const { rdf } = asSkos(data);
  return rdf.getSubjects(nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'), null)
    .filter(term => term.termType === 'NamedNode').map(term => ({ uri: term.value,
      labels: rdf.getObjects(term, nn(SKOS + 'prefLabel'), null).filter(v => v.termType === 'Literal')
        .map(v => ({ value: v.value, language: v.termType === 'Literal' ? v.language : '' })) }));
}

export function planSkos(store: Store, data: string | RdfStore, request: ImportRequest) {
  const { rdf, warnings: read } = asSkos(data);
  const scheme = nn(request.sourceScheme);
  if (!rdf.countQuads(scheme, nn(RDF + 'type'), nn(SKOS + 'ConceptScheme'), null))
    throw new DomainError(422, 'The selected IRI is not a declared skos:ConceptScheme.');
  const warnings = new Set<string>(read);
  const objects = (s: RdfTerm, p: string) => rdf.getObjects(s, nn(p), null);
  const notations = (subject: RdfTerm): Notation[] => objects(subject, SKOS + 'notation').map(value => {
    if (value.termType !== 'Literal') throw new DomainError(422, 'SKOS notations must be RDF literals.');
    return { value: value.value, datatype: value.datatype.value, ...(value.language ? { language: value.language } : {}) };
  });
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
    SKOS + 'definition', SKOS + 'broader', SKOS + 'narrower', SKOS + 'related', SKOS + 'topConceptOf', SKOS + 'notation',
    ...matches.map(match => SKOS + match), DCT + 'isReplacedBy', EX + 'status', EX + 'alias', EX + 'opposite', EX + 'slug', EX + 'formerSlug']);
  const schemeSupported = new Set([RDF + 'type', SKOS + 'prefLabel', SKOS + 'hasTopConcept', SKOS + 'notation', DCT + 'description', EX + 'hierarchy', EX + 'admissionTest', EX + 'slugUniqueDepth', EX + 'slugScope', EX + 'proposalSource', EX + 'outline', EX + 'maxDepth']);
  const plainLiterals = (subject: RdfTerm, predicate: string, field: string) => objects(subject, predicate).map(value => {
    if (value.termType !== 'Literal') throw new DomainError(422, `${field} must be literals.`); return value.value;
  });
  for (const q of rdf.getQuads(null, null, null, null)) {
    if (q.subject.equals(scheme) ? !schemeSupported.has(q.predicate.value) : members.has(q.subject.value) && !supported.has(q.predicate.value))
      warnings.add(`Unsupported predicate omitted: ${q.predicate.value}`);
    if ((q.subject.equals(scheme) || members.has(q.subject.value)) && q.predicate.value === RDF + 'type'
        && ![SKOS + 'Concept', SKOS + 'ConceptScheme'].includes(q.object.value))
      warnings.add(`Additional type declaration omitted: ${q.object.value}`);
  }
  const schemeLabel = preferred(scheme, SKOS + 'prefLabel', !request.label);
  const terms = [...members.values()].map(subject => {
    const memberships = named([...objects(subject, SKOS + 'inScheme'), ...objects(subject, SKOS + 'topConceptOf'),
      ...rdf.getSubjects(nn(SKOS + 'hasTopConcept'), subject, null)], 'Scheme membership');
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
    const slugs = plainLiterals(subject, EX + 'slug', 'Slugs');
    if (slugs.length > 1) throw new DomainError(422, `Multiple slugs for ${subject.value}.`);
    const scope = preferred(subject, SKOS + 'scopeNote') ?? preferred(subject, SKOS + 'definition');
    if (objects(subject, SKOS + 'scopeNote').length && objects(subject, SKOS + 'definition').length)
      warnings.add('skos:definition is omitted when a scope note is present.');
    return { key: subject.value, label: label.value, language: label.language || undefined,
      altLabels: [...new Set(altLabels)], notations: notations(subject), scopeNote: scope?.value ?? '',
      status: (statuses[0]?.value ?? 'active') as 'active', broader, relations,
      aliases: plainLiterals(subject, EX + 'alias', 'Aliases'),
      ...(slugs.length ? { slug: slugs[0] } : {}), formerSlugs: plainLiterals(subject, EX + 'formerSlug', 'Former slugs'),
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
    description: preferred(scheme, DCT + 'description')?.value ?? '', hierarchy: 'graph',
    admissionTest: preferred(scheme, EX + 'admissionTest')?.value ?? '', notations: notations(scheme), sourceUri: scheme.value,
    slugUniqueDepths: plainLiterals(scheme, EX + 'slugUniqueDepth', 'Slug depths').map(value => {
      if (!/^\d{1,3}$/.test(value)) throw new DomainError(422, 'Slug depths must be non-negative integers.'); return Number(value);
    }), ...maxDepth(plainLiterals(scheme, EX + 'maxDepth', 'Maximum depth')),
    slugScope: setting(plainLiterals(scheme, EX + 'slugScope', 'Slug scope'), ['siblings', 'scheme'], 'slug scope'),
    proposalSource: setting(plainLiterals(scheme, EX + 'proposalSource', 'Proposal source'), ['required', 'optional'], 'proposal source'),
    outline: setting(plainLiterals(scheme, EX + 'outline', 'Outline'), ['hierarchy', 'list'], 'outline') }, terms,
    sets: readCollections(rdf, scheme, new Set(members.keys()), request.language, warnings) });
  const declarations = objects(scheme, EX + 'hierarchy');
  const declared = declarations.length === 1 && declarations[0].termType === 'Literal' ? declarations[0].value
    : declarations.length ? 'ambiguous declaration' : undefined;
  const analysis = analyseStructure(plan, request.hierarchy, declared);
  return { plan, analysis, warnings: [...warnings] };
}

export async function exportSkos(store: Store, schemeId: string, at?: number): Promise<string> {
  const scheme = store.schemes(at).find(scheme => scheme.id === schemeId);
  if (!scheme) throw new DomainError(404, 'Scheme not found at this version.');
  const all = store.terms(undefined, at);
  const terms = all.filter(term => term.scheme === schemeId);
  const termIri = (id: string) => {
    const term = all.find(term => term.id === id);
    if (!term) throw new DomainError(422, 'Missing referenced term.');
    return nn(publicIri(term));
  };
  const subject = nn(scheme.sourceUri ?? `urn:terminology-mcp:scheme:${scheme.id}`);
  const quads: Quad[] = [];
  const add = (s: ReturnType<typeof nn>, p: string, o: ReturnType<typeof nn> | ReturnType<typeof lit> | ReturnType<typeof DataFactory.blankNode>) => quads.push(quad(s, nn(p), o));
  const addNotations = (s: ReturnType<typeof nn>, values: Notation[]) => values.forEach(value =>
    add(s, SKOS + 'notation', lit(value.value, value.language || nn(value.datatype))));
  add(subject, RDF + 'type', nn(SKOS + 'ConceptScheme'));
  add(subject, SKOS + 'prefLabel', lit(scheme.label, scheme.language));
  if (scheme.description) add(subject, DCT + 'description', lit(scheme.description, scheme.language));
  if (scheme.admissionTest) add(subject, EX + 'admissionTest', lit(scheme.admissionTest));
  add(subject, EX + 'hierarchy', lit(scheme.hierarchy));
  scheme.slugUniqueDepths.forEach(depth => add(subject, EX + 'slugUniqueDepth', lit(String(depth), nn('http://www.w3.org/2001/XMLSchema#integer'))));
  if (scheme.slugScope) add(subject, EX + 'slugScope', lit(scheme.slugScope));
  if (scheme.proposalSource) add(subject, EX + 'proposalSource', lit(scheme.proposalSource));
  if (scheme.outline) add(subject, EX + 'outline', lit(scheme.outline));
  if (scheme.maxDepth !== undefined) add(subject, EX + 'maxDepth', lit(String(scheme.maxDepth), nn('http://www.w3.org/2001/XMLSchema#integer')));
  addNotations(subject, scheme.notations);
  for (const term of terms) {
    const s = termIri(term.id);
    add(s, RDF + 'type', nn(SKOS + 'Concept'));
    add(s, SKOS + 'inScheme', subject);
    add(s, SKOS + 'prefLabel', lit(term.label, term.language));
    term.altLabels.forEach(value => add(s, SKOS + 'altLabel', lit(value, term.language)));
    addNotations(s, term.notations);
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
    add(s, EX + 'slug', lit(term.slug));
    term.formerSlugs.forEach(value => add(s, EX + 'formerSlug', lit(value)));
    add(s, EX + 'status', lit(term.status));
    term.replacedBy.forEach(id => add(s, DCT + 'isReplacedBy', termIri(id)));
  }
  const sets = store.sets(schemeId, at);
  const setIri = (id: string) => nn(sets.find(set => set.id === id)?.sourceUri ?? `urn:terminology-mcp:set:${id}`);
  const memberIri = (id: string) => sets.some(set => set.id === id) ? setIri(id) : termIri(id);
  for (const set of sets) {
    const s = setIri(set.id);
    add(s, RDF + 'type', nn(SKOS + (set.ordered ? 'OrderedCollection' : 'Collection')));
    add(s, SKOS + 'prefLabel', lit(set.label, set.language));
    add(s, EX + 'scheme', subject);
    add(s, EX + 'slug', lit(set.slug)); add(s, EX + 'owner', lit(set.owner)); add(s, EX + 'kind', lit(set.kind));
    if (set.description) add(s, DCT + 'description', lit(set.description, set.language));
    const members = set.recipe ? store.expandSet(set.id, at).terms.map(term => term.id) : set.members;
    members.forEach(id => add(s, SKOS + 'member', memberIri(id)));
    if (set.recipe) {
      const iris = (ids: string[]) => ids.map(id => termIri(id).value);
      add(s, EX + 'recipe', lit(JSON.stringify({ concepts: iris(set.recipe.concepts), narrower: iris(set.recipe.narrower),
        exclude: iris(set.recipe.exclude), around: set.recipe.around.map(rule => ({ ...rule, term: termIri(rule.term).value })) })));
    }
    if (set.ordered) {
      const cells = set.members.map(() => DataFactory.blankNode());
      add(s, SKOS + 'memberList', cells[0] ?? nn(RDF + 'nil'));
      cells.forEach((cell, i) => {
        quads.push(quad(cell, nn(RDF + 'first'), memberIri(set.members[i])));
        quads.push(quad(cell, nn(RDF + 'rest'), cells[i + 1] ?? nn(RDF + 'nil')));
      });
    }
  }
  const writer = new Writer({ prefixes: { skos: SKOS, dct: DCT, term: EX } });
  writer.addQuads(quads);
  return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result ?? '')));
}
