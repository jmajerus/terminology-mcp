import { z } from 'zod';

const text = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(200);
export const pathLabel = (label: string) => label.normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-|-$/g, '') || 'term';
// Concept Clusters' slugify, plus diacritic folding, a length cap and a fallback.
export const slugify = (label: string) => {
  const value = label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = value.length <= 80 ? value : value[80] === '-' ? value.slice(0, 80) : value.slice(0, 80).replace(/-[^-]*$/, '');
  return cut.replace(/-+$/, '') || 'term';
};
export const slugSchema = z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters and digits separated by single hyphens');
export const iriSchema = z.string().max(2000).refine(value => /^[a-z][a-z0-9+.-]*:/i.test(value)
  && !/^(javascript|data|vbscript|file):/i.test(value)
  && !/[\u0000-\u0020<>"{}|^`\\]/u.test(value), 'Use an absolute IRI');
export const relationSchema = z.object({ type: z.enum(['related', 'opposite']), target: id }).strict();
export const linkSchema = z.object({
  uri: iriSchema,
  match: z.enum(['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch']),
}).strict();
export const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
export const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
export const notationSchema = z.object({
  value: z.string().max(2000), datatype: iriSchema.default(XSD_STRING),
  language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).toLowerCase().optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.language) !== (value.datatype === RDF_LANG_STRING))
    context.addIssue({ code: 'custom', message: 'A language tag requires rdf:langString, and rdf:langString requires a language tag.' });
});
export type Notation = z.infer<typeof notationSchema>;
export const uniqueNotations = (values: Notation[]) => [...new Map(values.map(value =>
  [JSON.stringify([value.value, value.datatype, value.language ?? '']), value])).values()];
const fields = {
  label: text,
  altLabels: z.array(text).max(100).default([]),
  notations: z.array(notationSchema).max(100).default([]),
  scopeNote: z.string().trim().max(20000).default(''),
  status: z.enum(['provisional', 'active']).default('provisional'),
  relations: z.array(relationSchema).max(200).default([]),
  links: z.array(linkSchema).max(100).default([]),
};
export const createTermSchema = z.object({
  ...fields, scheme: id, broader: z.array(id).max(100).default([]),
  aliases: z.array(z.string().trim().min(1).max(2000)).max(100).default([]),
  slug: slugSchema.optional(),
  sourceUri: iriSchema.optional(),
  language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).optional(),
  // The term in another scheme it was copied from; resolved like a proposal's source.
  source: z.object({ ref: z.string().trim().min(1).max(2000), scheme: id.optional(),
    match: linkSchema.shape.match.default('closeMatch') }).strict().optional(),
}).strict();
export const editTermSchema = z.object({
  ...fields, notations: z.array(notationSchema).max(100).optional(), expectedChanged: z.number().int().positive(),
  reason: z.string().trim().max(2000).default(''),
  collections: z.array(id).max(1000).optional(), expectedVersion: z.number().int().nonnegative().optional(),
}).strict();
export const schemeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/), label: text,
  description: z.string().trim().max(10000).default(''),
  hierarchy: z.enum(['tree', 'poly', 'graph']),
  admissionTest: z.string().trim().max(10000).default(''),
  notations: z.array(notationSchema).max(100).default([]),
  slugUniqueDepths: z.array(z.number().int().min(0).max(500)).max(20).default([]),
  maxDepth: z.number().int().min(0).max(500).optional(),
  sourceUri: iriSchema.optional(),
  language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).optional(),
}).strict();
export type Scheme = z.infer<typeof schemeSchema> & { created: number };
export type CreateTerm = z.infer<typeof createTermSchema>;
export type EditTerm = z.infer<typeof editTermSchema>;
const evidenceSchema = z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 4096, 'Evidence is limited to 4 KiB of JSON.');
export type Match = z.infer<typeof linkSchema>['match'];
export type TermSource = { id: string; scheme: string; uri: string; label: string; match: Match };
export type Proposal = { proposer: string; evidence?: Record<string, unknown>; requestId?: string; source?: TermSource };
/** A term's public IRI: its source IRI, else an http(s) alias, else its URN. */
export const termIri = (term: { id: string; sourceUri?: string; aliases: string[] }) =>
  term.sourceUri ?? term.aliases.find(alias => /^https?:\/\//.test(alias)) ?? `urn:terminology-mcp:term:${term.id}`;
export type Term = Omit<CreateTerm, 'status' | 'slug' | 'source'> & {
  status: 'provisional' | 'active' | 'retired'; replacedBy: string[]; slug: string; formerSlugs: string[];
  id: string; created: number; changed: number; source?: TermSource; proposal?: Proposal;
};
export const proposeTermSchema = z.object({
  scheme: id, label: text.optional(), broader: z.string().min(1).max(2000),
  source: z.string().trim().min(1).max(2000).optional(), sourceScheme: id.optional(),
  match: linkSchema.shape.match.default('closeMatch'),
  altLabels: fields.altLabels, scopeNote: fields.scopeNote, slug: slugSchema.optional(),
  proposer: text.optional(), evidence: evidenceSchema.optional(), requestId: z.string().trim().min(1).max(200).optional(),
}).strict();
export const schemeSettingsSchema = z.object({
  maxDepth: z.number().int().min(0).max(500).nullable(), expectedVersion: z.number().int().nonnegative(),
}).strict();
const marker = z.string().trim().max(2000);
export const progressSchema = z.object({
  log: z.string().min(1).max(200), through: z.number().int().nonnegative(),
  schemes: z.array(id).max(50).optional(), label: text.optional(), reset: z.boolean().default(false),
  blocked: z.object({ at: z.number().int().positive(), code: z.string().trim().max(60).optional(), reason: marker.default('') }).strict().optional(),
}).strict();
export type Subscriber = { id: string; label: string; schemes: string[]; log: string; through: number;
  blocked: { at: number; code?: string; reason: string } | null; lastSeen: string; registered: string };
export type TermView = Term & { path: string | null; depth: number; narrower: string[] };
export const setRecipeSchema = z.object({
  concepts: z.array(z.string().min(1).max(2000)).max(10000).default([]), narrower: z.array(z.string().min(1).max(2000)).max(1000).default([]),
  around: z.array(z.object({ term: z.string().min(1).max(2000), depth: z.number().int().min(0).max(10),
    types: z.array(z.enum(['broader', 'narrower', 'related', 'opposite'])).min(1).max(4),
  }).strict()).max(100).default([]), exclude: z.array(z.string().min(1).max(2000)).max(10000).default([]),
}).strict();
export const conceptSetSchema = z.object({
  scheme: id, slug: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/), label: text,
  description: z.string().trim().max(10000).default(''), owner: text.default('local-editor'),
  kind: z.enum(['theme', 'profile', 'map-view']).default('theme'),
  ordered: z.boolean().default(false), members: z.array(id).max(10000).default([]),
  recipe: setRecipeSchema.optional(),
  sourceUri: iriSchema.optional(), language: z.string().regex(/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/).optional(),
}).strict();
export type ConceptSet = z.infer<typeof conceptSetSchema> & { id: string; created: number; changed: number; deleted?: boolean };
export type Change = {
  n: number; kind: 'scheme-added' | 'added' | 'labelled' | 'noted' | 'updated' | 'moved' | 'merged' | 'split' | 'retired' | 'slugged' | 'imported' | 'scheme-changed' | 'set-added' | 'set-changed' | 'set-deleted';
  terms: string[]; before: Term | Scheme | ConceptSet | null; after: Term | Scheme | ConceptSet;
  breaking: boolean; author: string; reason: string; at: string;
  beforeTerms?: Term[]; afterTerms?: Term[];
  beforeSets?: ConceptSet[]; afterSets?: ConceptSet[];
  proposal?: Proposal;
};
const operationBase = { expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().max(2000).default('') };
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ ...operationBase, kind: z.literal('move'), broader: z.array(id).max(100) }).strict(),
  z.object({ ...operationBase, kind: z.literal('merge'), target: id }).strict(),
  z.object({ ...operationBase, kind: z.literal('retire'), replacements: z.array(id).max(20).default([]) }).strict(),
  z.object({ ...operationBase, kind: z.literal('slug'), slug: slugSchema }).strict(),
  z.object({ ...operationBase, kind: z.literal('split'),
    newTerms: z.array(z.object({ label: text, scopeNote: z.string().trim().max(20000).default('') }).strict()).min(2).max(20),
    children: z.array(z.object({ id, targets: z.array(z.number().int().nonnegative()).min(1).max(20) }).strict()).max(10000),
  }).strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const importPlanSchema = z.object({
  scheme: schemeSchema,
  sets: z.array(conceptSetSchema.omit({ scheme: true }).extend({ key: iriSchema,
    members: z.array(iriSchema).max(10000).default([]),
  }).strict()).max(1000).default([]),
  terms: z.array(createTermSchema.omit({ scheme: true, source: true }).extend({
    key: iriSchema, broader: z.array(iriSchema).default([]),
    relations: z.array(z.object({ type: z.enum(['related', 'opposite']), target: iriSchema }).strict()).default([]),
    status: z.enum(['provisional', 'active', 'retired']).default('active'),
    replacedBy: z.array(iriSchema).default([]),
    formerSlugs: z.array(slugSchema).max(100).default([]),
  }).strict()).min(1).max(10000),
}).strict();
export type ImportPlan = z.infer<typeof importPlanSchema>;
export class DomainError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) { super(message); }
}
