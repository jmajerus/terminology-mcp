import { Client, iri, literal, ownedGraph } from './client.js';

export class Probe {
  readonly current: string;
  readonly history: string;
  readonly root: string;
  readonly control: string;
  constructor(readonly client: Client, readonly namespace: string, readonly scenario: string,
    private register: (graph: string) => void) {
    if (!/^[a-z0-9-]+$/.test(scenario)) throw new Error('Invalid scenario name.');
    this.current = this.graph('current');
    this.history = this.graph('history');
    this.root = this.term('politics');
    this.control = iri(`${namespace}${scenario}:control`);
  }
  term(id: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid fixture term.');
    return iri(`${this.namespace}term:${id}`);
  }
  graph(suffix: string): string {
    const name = `${this.namespace}${this.scenario}:${suffix}`;
    const value = ownedGraph(this.namespace, name);
    this.register(name);
    return value;
  }
  async seed() {
    const t = (id: string) => this.term(id);
    await this.client.update(`seed-${this.scenario}`, `INSERT DATA { GRAPH ${this.current} {
      ${this.control} ex:version 1 .
      ${t('subjects')} a skos:ConceptScheme ; skos:prefLabel "Subjects" ; ex:hierarchy "tree" .
      ${t('human-work')} a skos:ConceptScheme ; skos:prefLabel "Human work" ; ex:hierarchy "poly" .
      ${t('society')} a skos:Concept ; skos:inScheme ${t('subjects')} ; skos:prefLabel "Society" ; ex:changed 1 .
      ${t('politics')} a skos:Concept ; skos:inScheme ${t('subjects')} ; skos:prefLabel "Politics" ;
        skos:altLabel "Political life" ; skos:scopeNote "Institutions and collective decisions." ;
        skos:broader ${t('society')} ; ex:alias "subjects:society/politics" ; ex:changed 1 .
      ${t('opinion')} a skos:Concept ; skos:inScheme ${t('subjects')} ; skos:prefLabel "Public opinion" ;
        skos:broader ${t('politics')} ; ex:changed 1 .
      ${t('voting')} a skos:Concept ; skos:inScheme ${t('subjects')} ; skos:prefLabel "Voting" ;
        skos:broader ${t('politics')} ; ex:changed 1 .
      ${t('polling')} a skos:Concept ; skos:inScheme ${t('subjects')} ; skos:prefLabel "Polling" ;
        skos:broader ${t('opinion')} ; ex:changed 1 .
      ${t('agency')} a skos:Concept ; skos:inScheme ${t('human-work')} ; skos:prefLabel "Agency" ;
        skos:related ${t('politics')} ; ex:changed 1 .
      ${t('connection')} a skos:Concept ; skos:inScheme ${t('human-work')} ; skos:prefLabel "Connection" ; ex:changed 1 .
      ${t('solidarity')} a skos:Concept ; skos:inScheme ${t('human-work')} ; skos:prefLabel "Solidarity" ;
        skos:broader ${t('agency')}, ${t('connection')} ; ex:opposite ${t('isolation')} ; ex:changed 1 .
      ${t('isolation')} a skos:Concept ; skos:inScheme ${t('human-work')} ; skos:prefLabel "Isolation" ; ex:changed 1 .
    } }; COPY GRAPH ${this.current} TO GRAPH ${this.graph('version:1')}`);
  }
  async labels(name: string, pattern: string, graph = this.current): Promise<string[]> {
    const result = await this.client.select(name,
      `SELECT DISTINCT ?label WHERE { GRAPH ${graph} { ${pattern} ?term skos:prefLabel ?label } } ORDER BY ?label`);
    return result.results.bindings.map(row => row.label.value);
  }
  editStatement(expected: number, label: string, token: string) {
    if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('Invalid expected version.');
    if (!/^[a-z0-9-]+$/.test(token)) throw new Error('Invalid request token.');
    const receipt = iri(`${this.namespace}${this.scenario}:request:${token}`);
    const next = expected + 1;
    // One conditional update writes current data, the journal, and a complete
    // immutable graph snapshot. Full snapshots are deliberately only a baseline.
    return `DELETE { GRAPH ${this.current} {
      ${this.root} skos:prefLabel ?oldLabel ; ex:changed ${expected} .
      ${this.control} ex:version ${expected} .
    } }
    INSERT {
      GRAPH ${this.current} {
        ${this.root} skos:prefLabel ${literal(label)} ; ex:changed ${next} .
        ${this.control} ex:version ${next} .
      }
      GRAPH ${this.history} {
        ${receipt} a ex:Change ; ex:number ${next} ; ex:term ${this.root} ;
          ex:before ?oldLabel ; ex:after ${literal(label)} ; ex:at ?now ; ex:breaking true .
      }
      GRAPH ${this.graph(`version:${next}`)} { ?s ?p ?snapshotObject }
    }
    WHERE {
      GRAPH ${this.current} {
        ${this.control} ex:version ${expected} .
        ${this.root} ex:changed ${expected} ; skos:prefLabel ?oldLabel .
        ?s ?p ?o .
      }
      BIND(NOW() AS ?now)
      BIND(IF(?s = ${this.root} && ?p = skos:prefLabel, ${literal(label)},
        IF((?s = ${this.root} && ?p = ex:changed) || (?s = ${this.control} && ?p = ex:version), ${next}, ?o)) AS ?snapshotObject)
    }`;
  }
  async rename(expected: number, label: string, token: string): Promise<boolean> {
    await this.client.update(`rename-${this.scenario}-${token}`, this.editStatement(expected, label, token));
    // SPARQL Update's success response does not distinguish a no-op from a
    // mutation. A receipt in the same transaction tells this caller it applied.
    return this.client.ask(`receipt-${this.scenario}-${token}`, `ASK { GRAPH ${this.history} {
      ${iri(`${this.namespace}${this.scenario}:request:${token}`)} a ex:Change
    } }`);
  }
  async summary() {
    const labels = await this.labels(`labels-${this.scenario}`, `VALUES ?term { ${this.root} }`);
    const rows = await this.client.select(`events-${this.scenario}`,
      `SELECT ?event ?n WHERE { GRAPH ${this.history} { ?event a ex:Change ; ex:number ?n } }`);
    return { labels, events: rows.results.bindings.map(row => ({ event: row.event.value, n: Number(row.n.value) })) };
  }
}
