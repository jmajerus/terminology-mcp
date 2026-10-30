import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client, cleanupStatement, iri, literal, namespacePattern, OxigraphError } from './client.js';
import { Probe } from './probe.js';

type Check = { name: string; status: 'passed' | 'failed'; ms: number; details: unknown };
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: npm run test:oxigraph -- [--endpoint URL] [--keep] [--rounds N] [--writers N]
Runs against OXIGRAPH_URL or http://oxigraph.localdomain:7878.
Writes only unique urn:terminology-mcp:feasibility:<UUID>: graphs.
Reports and exact cleanup statements go under data/oxigraph-feasibility/<UUID>/.
Graphs are removed by default; --keep retains them for inspection.
To retry cleanup: npm run test:oxigraph -- --cleanup PATH/manifest.json
An acceptance failure exits 1 and still saves the report and performs cleanup.`);
  process.exit(0);
}
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
  return value;
}
function positiveOption(name: string, fallback: number, min: number, max: number) {
  const value = Number(option(name) ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}–${max}.`);
  return value;
}
const known = new Set(['--endpoint', '--rounds', '--writers', '--keep', '--cleanup']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  if (args[i] !== '--keep') i++;
}
const cleanupPath = option('--cleanup');
if (cleanupPath) {
  const manifest = JSON.parse(readFileSync(cleanupPath, 'utf8')) as { namespace: string; endpoint: string; graphs: string[] };
  if (!namespacePattern.test(manifest.namespace) || !Array.isArray(manifest.graphs)) throw new Error('Invalid manifest.');
  const client = new Client(option('--endpoint') ?? manifest.endpoint);
  await client.update('cleanup', cleanupStatement(manifest.namespace, manifest.graphs));
  console.log(`Removed ${manifest.graphs.length} owned test graphs from ${client.endpoint}.`);
  process.exit(0);
}

const rounds = positiveOption('--rounds', 10, 1, 100);
const writers = positiveOption('--writers', 8, 2, 20);
const keep = args.includes('--keep');
const runId = randomUUID();
const namespace = `urn:terminology-mcp:feasibility:${runId}:`;
const client = new Client(option('--endpoint') ?? process.env.OXIGRAPH_URL ?? 'http://oxigraph.localdomain:7878');
const directory = resolve('data/oxigraph-feasibility', runId);
mkdirSync(directory, { recursive: true });
const graphs = new Set<string>();
const checks: Check[] = [];
const raceResults: unknown[] = [];
let cleanup = keep ? 'retained by --keep' : 'not attempted';
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true; });
function manifest() {
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ runId, namespace, endpoint: client.endpoint, graphs: [...graphs] }, null, 2) + '\n');
  if (graphs.size) writeFileSync(join(directory, 'cleanup.ru'), cleanupStatement(namespace, [...graphs]) + '\n');
}
function register(graph: string) { graphs.add(graph); manifest(); }
function probe(name: string) { return new Probe(client, namespace, name, register); }
async function check(name: string, work: () => Promise<unknown>) {
  if (interrupted) throw new Error('Interrupted; cleaning up.');
  const started = performance.now();
  try {
    const details = await work();
    checks.push({ name, status: 'passed', ms: Math.round(performance.now() - started), details });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: 'failed', ms: Math.round(performance.now() - started),
      details: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
const startedAt = new Date().toISOString();
manifest();
console.log(`Oxigraph feasibility run ${runId}\nEndpoint: ${client.endpoint}\nArtifacts: ${directory}`);
try {
  // Connectivity must succeed before attempting any writes.
  await client.ask('connectivity', 'ASK { }');
  console.log(`Server: ${client.server}`);
  const p = probe('features');
  await p.seed();
  await check('SKOS fixture, hierarchy and polyhierarchy', async () => {
    const concepts = await client.select('concept-count', `SELECT (COUNT(?term) AS ?n) WHERE { GRAPH ${p.current} { ?term a skos:Concept } }`);
    assert.equal(Number(concepts.results.bindings[0].n.value), 9);
    const ancestors = await p.labels('ancestors', `${p.term('polling')} skos:broader+ ?term .`);
    assert.deepEqual(ancestors, ['Politics', 'Public opinion', 'Society']);
    const descendants = await p.labels('descendants', `?term skos:broader+ ${p.root} .`);
    assert.deepEqual(descendants, ['Polling', 'Public opinion', 'Voting']);
    const parents = await p.labels('multiple-parents', `${p.term('solidarity')} skos:broader ?term .`);
    assert.deepEqual(parents, ['Agency', 'Connection']);
    return { concepts: 9, ancestors, descendants, multipleParents: parents };
  });
  await check('concept-set expansion and exclusion', async () => {
    const result = await p.labels('expand-exclude', `?term skos:broader+ ${p.root} .
      FILTER NOT EXISTS { ?term skos:broader* ${p.term('opinion')} }`);
    assert.deepEqual(result, ['Voting']);
    return { recipe: 'narrower of Politics, excluding Public opinion and its descendants', result };
  });
  await check('bounded typed and cross-scheme traversal', async () => {
    const one = await p.labels('around-depth-1', `${p.root} (skos:related|^skos:related) ?term .`);
    assert.deepEqual(one, ['Agency']);
    // SPARQL 1.1 has no {min,max} property path syntax. Express the
    // bounded recipe as one step UNION two steps, excluding self.
    const two = await p.labels('around-depth-2', `{
          ${p.root} (skos:related|^skos:related|^skos:broader) ?term
        } UNION {
          ${p.root} (skos:related|^skos:related|^skos:broader)/(skos:related|^skos:related|^skos:broader) ?term
        } FILTER(?term != ${p.root})`);
    assert.ok(two.includes('Agency') && two.includes('Solidarity'));
    const opposite = await p.labels('typed-opposite', `${p.term('solidarity')} (ex:opposite|^ex:opposite) ?term .`);
    assert.deepEqual(opposite, ['Isolation']);
    return { depth1Related: one, depth2SelectedEdges: two, opposite };
  });
  await check('RDF export and round-trip import', async () => {
    const turtle = await client.turtle('export', `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ${p.current} { ?s ?p ?o } }`);
    writeFileSync(join(directory, 'fixture.ttl'), turtle);
    const importName = `${namespace}features:roundtrip`;
    const imported = p.graph('roundtrip');
    await client.loadTurtle('import', namespace, importName, turtle);
    const equal = await client.ask('roundtrip-equality', `ASK {
      FILTER NOT EXISTS { GRAPH ${p.current} { ?s ?p ?o } FILTER NOT EXISTS { GRAPH ${imported} { ?s ?p ?o } } }
      FILTER NOT EXISTS { GRAPH ${imported} { ?s ?p ?o } FILTER NOT EXISTS { GRAPH ${p.current} { ?s ?p ?o } } }
    }`);
    assert.equal(equal, true);
    return { identicalTriples: true, artifact: 'fixture.ttl' };
  });
  const renamed = 'Political "behavior" \\ participation\n社会';
  await check('atomic rename, journal and historical graph reads', async () => {
    assert.equal(await p.rename(1, renamed, 'first'), true);
    assert.deepEqual(await p.labels('current-label', `VALUES ?term { ${p.root} }`), [renamed]);
    assert.deepEqual(await p.labels('version-1-label', `VALUES ?term { ${p.root} }`, p.graph('version:1')), ['Politics']);
    assert.deepEqual(await p.labels('version-2-label', `VALUES ?term { ${p.root} }`, p.graph('version:2')), [renamed]);
    const journal = await client.select('journal-values', `SELECT ?before ?after ?n WHERE { GRAPH ${p.history} {
      ?event a ex:Change ; ex:before ?before ; ex:after ?after ; ex:number ?n
    } }`);
    assert.equal(journal.results.bindings.length, 1);
    assert.equal(journal.results.bindings[0].before.value, 'Politics');
    assert.equal(journal.results.bindings[0].after.value, renamed);
    const alias = await p.labels('old-alias', '?term ex:alias "subjects:society/politics" .');
    assert.deepEqual(alias, [renamed]);
    return { stableIri: p.root, oldLabel: 'Politics', newLabel: renamed, events: 1, versions: [1, 2] };
  });
  await check('stale edit changes neither current data nor history', async () => {
    const before = await p.summary();
    assert.equal(await p.rename(1, 'Stale overwrite', 'stale'), false);
    assert.deepEqual(await p.summary(), before);
    return { staleRequestApplied: false, currentAndJournalUnchanged: true };
  });
  await check('runtime failure rolls back earlier operations in one update request', async () => {
    const marker = iri(`${namespace}rollback-marker`);
    let failure: unknown;
    try {
      await client.update('intentional-runtime-failure', `INSERT DATA { GRAPH ${p.current} { ${marker} ex:value "must roll back" } };
        CREATE GRAPH ${p.current}`);
    } catch (error) { failure = error; }
    assert.ok(failure instanceof OxigraphError && failure.status >= 400, 'Expected CREATE of existing graph to fail.');
    const leaked = await client.ask('rollback-marker-absent', `ASK { GRAPH ${p.current} { ${marker} ?p ?o } }`);
    assert.equal(leaked, false, 'Earlier INSERT survived the later runtime failure.');
    return { rejectedStatus: failure.status, earlierInsertRolledBack: true };
  });
  await check('single-query readers see current data, journal and snapshot together', async () => {
    const visibility = probe('visibility');
    await visibility.seed();
    const snapshotBase = `${namespace}visibility:version:`;
    const writes = async () => {
      for (let n = 1; n <= 12; n++) {
        if (interrupted) throw new Error('Interrupted.');
        assert.equal(await visibility.rename(n, `Revision ${n + 1}`, `serial-${n}`), true);
      }
    };
    const reads = async () => {
      const observed: number[] = [];
      for (let i = 0; i < 30; i++) {
        const result = await client.select('atomic-visibility', `SELECT ?head ?label ?hasJournal ?snapshotHead WHERE {
          GRAPH ${visibility.current} { ${visibility.control} ex:version ?head . ${visibility.root} skos:prefLabel ?label }
          BIND(EXISTS { GRAPH ${visibility.history} { ?event ex:number ?head } } AS ?hasJournal)
          BIND(IRI(CONCAT(${literal(snapshotBase)}, STR(?head))) AS ?snapshot)
          OPTIONAL { GRAPH ?snapshot { ${visibility.control} ex:version ?snapshotHead } }
        }`);
        assert.equal(result.results.bindings.length, 1);
        const row = result.results.bindings[0];
        const head = Number(row.head.value);
        assert.equal(Number(row.snapshotHead?.value), head);
        if (head > 1) {
          assert.equal(row.hasJournal.value, 'true');
          assert.equal(row.label.value, `Revision ${head}`);
        }
        observed.push(head);
      }
      return observed;
    };
    // Drain both tasks even on failure before cleanup can remove their graphs.
    const outcomes = await Promise.allSettled([writes(), reads()]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    return { writes: 12, reads: 30, observedHeads: outcomes[1].status === 'fulfilled' ? outcomes[1].value : [] };
  });
  await check(`concurrent conditional updates: ${rounds} rounds × ${writers} writers`, async () => {
    let unsafeRounds = 0;
    for (let round = 0; round < rounds; round++) {
      if (interrupted) throw new Error('Interrupted.');
      const race = probe(`race-${round}`);
      await race.seed();
      const outcomes = await Promise.allSettled(Array.from({ length: writers }, (_, writer) =>
        race.rename(1, `Writer ${writer}`, `writer-${writer}`)));
      const accepted = outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value).length;
      const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => String(outcome.reason));
      const summary = await race.summary();
      const safe = accepted === 1 && summary.events.length === 1 && summary.labels.length === 1 && errors.length === 0;
      if (!safe) unsafeRounds++;
      raceResults.push({ round, accepted, errors, ...summary });
    }
    writeFileSync(join(directory, 'concurrency.json'), JSON.stringify(raceResults, null, 2) + '\n');
    assert.equal(unsafeRounds, 0, `${unsafeRounds}/${rounds} rounds failed the exactly-one-writer rule; see concurrency.json.`);
    return { rounds, writers, exactlyOneWinnerEachRound: true, artifact: 'concurrency.json' };
  });
  await check('application-serialized edits reject stale contenders', async () => {
    const serial = probe('serialized');
    await serial.seed();
    let queue: Promise<unknown> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    };
    const outcomes = await Promise.allSettled(Array.from({ length: writers }, (_, writer) => enqueue(() =>
      serial.rename(1, `Serialized writer ${writer}`, `serial-${writer}`))));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled' && outcome.value).length, 1);
    const summary = await serial.summary();
    assert.equal(summary.events.length, 1);
    assert.equal(summary.labels.length, 1);
    return { writers, accepted: 1, limitation: 'One application process owns all writes; this queue does not coordinate multiple processes or direct SPARQL writers.' };
  });
  await check('SPARQL detects invalid hierarchies; storage alone does not enforce them', async () => {
    const rules = probe('rules');
    await rules.seed();
    await client.update('insert-deliberate-invalid-hierarchy', `INSERT DATA { GRAPH ${rules.current} {
      ${rules.root} skos:broader ${rules.term('opinion')} .
    } }`);
    const cycle = await client.ask('detect-cycle', `ASK { GRAPH ${rules.current} { ?term skos:broader+ ?term } }`);
    const multiple = await client.select('detect-multiple-tree-parents', `SELECT ?term (COUNT(DISTINCT ?parent) AS ?n) WHERE {
      GRAPH ${rules.current} { ?term skos:inScheme ?scheme ; skos:broader ?parent . ?scheme ex:hierarchy "tree" }
    } GROUP BY ?term HAVING(COUNT(DISTINCT ?parent) > 1)`);
    assert.equal(cycle, true);
    assert.equal(multiple.results.bindings.length, 1);
    return { invalidDataAcceptedByStorage: true, cycleDetected: true, multipleTreeParentsDetected: true,
      limitation: 'Validation must be part of the controlled write path; SKOS storage does not enforce these application rules.' };
  });
} catch (error) {
  checks.push({ name: 'run setup or interruption', status: 'failed', ms: 0, details: error instanceof Error ? error.message : String(error) });
} finally {
  if (!keep && graphs.size) {
    try {
      await client.update('cleanup', cleanupStatement(namespace, [...graphs]));
      const remaining = await client.select('verify-cleanup', `SELECT ?g WHERE {
        VALUES ?g { ${[...graphs].map(iri).join(' ')} } GRAPH ?g { }
      }`);
      assert.equal(remaining.results.bindings.length, 0, 'Some test graphs still exist.');
      cleanup = 'removed and verified';
      console.log(`Cleanup: ${graphs.size} owned graphs removed and verified.`);
    } catch (error) {
      cleanup = `FAILED: ${error instanceof Error ? error.message : String(error)}; retry with --cleanup ${join(directory, 'manifest.json')}`;
      checks.push({ name: 'cleanup', status: 'failed', ms: 0, details: cleanup });
    }
  }
  const passed = checks.filter(item => item.status === 'passed').length;
  const failed = checks.filter(item => item.status === 'failed').length;
  const report = { runId, namespace, endpoint: client.endpoint, server: client.server, startedAt,
    finishedAt: new Date().toISOString(), graphs: [...graphs], cleanup, passed, failed, checks, raceResults };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(directory, 'requests.jsonl'), client.trace.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(directory, 'report.md'), `# Oxigraph feasibility results\n\nServer: ${client.server}\n\nEndpoint: ${client.endpoint}\n\nRun: ${runId}\n\n${passed} passed; ${failed} failed. Cleanup: ${cleanup}.\n\n` +
    checks.map(item => `## ${item.status.toUpperCase()}: ${item.name}\n\n\`\`\`json\n${JSON.stringify(item.details, null, 2)}\n\`\`\`\n`).join('\n') +
    '\nThese are small-fixture functional checks, not production load or durability certification. See requests.jsonl for the exact requests and concurrency.json for writer outcomes.\n');
  console.log(`${passed} passed; ${failed} failed. Report: ${join(directory, 'report.md')}`);
  if (failed || interrupted) process.exitCode = 1;
}
