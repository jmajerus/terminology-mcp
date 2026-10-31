import { DataFactory, Store as RdfStore, type Term } from 'n3';
import { DomainError, setRecipeSchema } from './model.js';
const { namedNode: nn } = DataFactory;
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const EX = 'urn:terminology-mcp:vocab:';
const DCT = 'http://purl.org/dc/terms/';

export function readCollections(rdf: RdfStore, scheme: Term, concepts: Set<string>, language: string, warnings: Set<string>) {
  const objects = (s: Term, p: string) => rdf.getObjects(s, nn(p), null);
  const candidates = new Map<string, Term>();
  for (const type of ['Collection', 'OrderedCollection'])
    rdf.getSubjects(nn(RDF + 'type'), nn(SKOS + type), null).forEach(s => candidates.set(s.id, s));
  for (const p of ['member', 'memberList'])
    rdf.getSubjects(nn(SKOS + p), null, null).forEach(s => candidates.set(s.id, s));
  if (candidates.size > 1000) throw new DomainError(413, 'At most 1,000 collections can be imported.');
  const rows = [...candidates.values()].map(subject => {
    const lists = objects(subject, SKOS + 'memberList');
    const ordered = lists.length > 0 || objects(subject, RDF + 'type').some(t => t.value === SKOS + 'OrderedCollection');
    if (lists.length > 1 || (ordered && lists.length !== 1)) throw new DomainError(422, 'An ordered collection needs exactly one memberList.');
    const listed: Term[] = [], seen = new Set<string>();
    let cell: Term | undefined = lists[0];
    while (cell && !cell.equals(nn(RDF + 'nil'))) {
      if (!['NamedNode', 'BlankNode'].includes(cell.termType) || seen.has(cell.id) || seen.size >= 10000)
        throw new DomainError(422, 'Malformed, cyclic, or oversized collection memberList.');
      seen.add(cell.id);
      const first = objects(cell, RDF + 'first'), rest = objects(cell, RDF + 'rest');
      if (first.length !== 1 || rest.length !== 1) throw new DomainError(422, 'Each memberList cell needs exactly one rdf:first and rdf:rest.');
      listed.push(first[0]); cell = rest[0];
    }
    const direct = objects(subject, SKOS + 'member');
    if (ordered && direct.some(member => !listed.some(item => item.equals(member))))
      throw new DomainError(422, 'An ordered collection has members missing from its memberList.');
    return { subject, ordered, values: ordered ? listed : direct };
  });
  const included = new Set(rows.filter(row => objects(row.subject, EX + 'scheme').some(s => s.equals(scheme)) ||
    row.values.some(member => concepts.has(member.value))).map(row => row.subject.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (included.has(row.subject.id) || row.values.some(member => included.has(member.id))) {
      for (const subject of [row.subject, ...row.values.filter(member => candidates.has(member.id))])
        if (!included.has(subject.id)) { included.add(subject.id); changed = true; }
    }
  }
  const literal = (subject: Term, predicate: string) => {
    const values = objects(subject, predicate);
    if (values.some(v => v.termType !== 'Literal')) throw new DomainError(422, 'Collection metadata must be literals.');
    const selected = values.filter(v => v.termType === 'Literal' && v.language.toLowerCase() === language.toLowerCase());
    const choices = selected.length ? selected : values.filter(v => v.termType === 'Literal' && !v.language);
    if (values.length > choices.length) warnings.add(`Collection metadata in other languages omitted; importing ${language}.`);
    if (choices.length > 1) throw new DomainError(422, `Multiple collection values for ${predicate}.`);
    return choices[0];
  };
  const supported = new Set([RDF + 'type', SKOS + 'prefLabel', SKOS + 'member', SKOS + 'memberList', DCT + 'description',
    'http://www.w3.org/2000/01/rdf-schema#label', EX + 'scheme', EX + 'slug', EX + 'owner', EX + 'kind', EX + 'recipe']);
  return rows.filter(row => included.has(row.subject.id)).map((row, i) => {
    if (row.subject.termType !== 'NamedNode') throw new DomainError(422, 'Collections must have named IRIs; blank-node collections are not supported.');
    if (concepts.has(row.subject.value) || row.subject.equals(scheme) || objects(row.subject, RDF + 'type').some(t => [SKOS + 'Concept', SKOS + 'ConceptScheme'].includes(t.value)))
      throw new DomainError(422, 'A SKOS collection cannot also be a concept or scheme.');
    const members = row.values.map(member => {
      if (member.termType !== 'NamedNode' || (!concepts.has(member.value) && !included.has(member.id)))
        throw new DomainError(422, `Collection member is outside the selected scheme or unsupported: ${member.value}`);
      return member.value;
    });
    for (const q of rdf.getQuads(row.subject, null, null, null)) if (!supported.has(q.predicate.value))
      warnings.add(`Unsupported collection predicate omitted: ${q.predicate.value}`);
    const label = literal(row.subject, SKOS + 'prefLabel') ?? literal(row.subject, 'http://www.w3.org/2000/01/rdf-schema#label');
    const recipeLiteral = literal(row.subject, EX + 'recipe');
    let recipe;
    if (recipeLiteral) {
      try { recipe = setRecipeSchema.parse(JSON.parse(recipeLiteral.value)); }
      catch { throw new DomainError(422, 'Invalid collection recipe extension.'); }
    }
    return { key: row.subject.value, label: label?.value ?? row.subject.value.slice(-200), language: label?.termType === 'Literal' ? label.language || undefined : undefined,
      slug: literal(row.subject, EX + 'slug')?.value ?? `collection-${i + 1}`, ordered: row.ordered, members: recipe ? [] : members,
      ...(recipe ? { recipe } : {}),
      description: literal(row.subject, DCT + 'description')?.value ?? '', owner: literal(row.subject, EX + 'owner')?.value ?? 'local-editor',
      kind: literal(row.subject, EX + 'kind')?.value ?? 'theme' };
  });
}
