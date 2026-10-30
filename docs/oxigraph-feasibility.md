# Oxigraph feasibility test

Implemented as a separate experiment under `experiments/oxigraph/`. It does
not change the SQLite store, editor, or normal application startup. It needs
Node.js 22+ and the existing npm dependencies; no additional packages.

## Run it

```sh
npm run test:oxigraph
```

The default endpoint is `http://oxigraph.localdomain:7878`. Override it with
`OXIGRAPH_URL` or an explicit argument:

```sh
npm run test:oxigraph -- --endpoint http://localhost:7878 --rounds 10 --writers 8
```

The command writes **sample data** to uniquely named graphs under
`urn:terminology-mcp:feasibility:<random-UUID>:`. All mutations explicitly
address these graphs. It never loads the workspace database, edits the
server's default graph, or issues a dataset-wide clear/drop. Graph names
are recorded locally before each write that could create them.

By default, it drops its graphs in `finally` and verifies their removal,
even when an acceptance check fails. To retain them for the query console:

```sh
npm run test:oxigraph -- --keep
```

The printed artifact directory contains:

| Artifact | Content |
| --- | --- |
| `report.md`, `report.json` | Check results, timings, namespace, server header, and cleanup status |
| `requests.jsonl` | Exact HTTP request bodies, statuses, errors, and durations |
| `fixture.ttl` | RDF exported from the sample taxonomy |
| `concurrency.json` | Every writer's outcome, final labels, and journal entries by round |
| `manifest.json`, `cleanup.ru` | Exact owned graph names and repeatable cleanup |

These artifacts live under ignored `data/oxigraph-feasibility/<UUID>/`.
If a process is forcibly killed or the server becomes unreachable, use the
manifest to retry cleanup:

```sh
npm run test:oxigraph -- --cleanup data/oxigraph-feasibility/<UUID>/manifest.json
```

The runner returns exit code **1** if an acceptance check fails, including
the concurrent-writer check. An expected negative feasibility result still
produces a report and cleans up; it is not silently treated as a pass.
`npm test` does not contact Oxigraph; its additional unit tests verify graph
ownership checks, unsafe-input rejection, and HTTP error handling.

## Recorded results: 2026-10-30

Server response: **Oxigraph/0.5.13** at the default endpoint.
Run: `b6c33844-3964-4820-b050-0ebeeb861ed0`.
Full evidence is in that run's local artifact directory.

**10 acceptance checks passed; 1 failed. All 67 registered test graph names
were removed and their absence verified.**

| Check | Result |
| --- | --- |
| SKOS fixture with nine concepts, tree ancestors/descendants, and two-parent polyhierarchy | Pass |
| Descendant expansion with subtree exclusion | Pass |
| Bounded traversal, incoming/outgoing related edges, cross-scheme links, and typed opposite edges | Pass |
| Turtle export and import through Graph Store HTTP, with exact triple equality | Pass |
| Conditional rename commits current data, journal entry, and historical snapshot together | Pass |
| Later stale edit changes neither current data nor journal | Pass |
| Runtime failure after an earlier write in the same update request rolls that write back | Pass |
| Single-query readers observe matching current data, journal, and snapshot while edits run | Pass |
| Ten rounds of eight simultaneous writers produce exactly one successful edit per round | **Fail** |
| Eight competing requests serialized through one application process produce one successful edit | Pass |
| Invalid hierarchy data can be detected with SPARQL, but storage alone does not reject it | Pass; application validation required |

The concurrency failure was unambiguous: **all eight writers applied in every
round**, leaving eight preferred labels and eight journal entries claiming
version 2. Each writer used the same `WHERE` condition requiring version 1.
That condition rejected a stale edit after a preceding request completed,
but did not protect against requests evaluating the condition concurrently.
The test therefore does not support using a conditional SPARQL update as
a database-enforced compare-and-swap or a global changelog sequencer.

The visibility check made 30 reads during a sequence of 12 writes. Each read
checked current label and version, the journal receipt, and the corresponding
snapshot within one SPARQL query. This is a small functional observation,
not a proof covering every possible interleaving.

## What the experiment implements

SKOS carries labels, alternative labels, scope notes, scheme membership,
broader relations, and associative links. A small `ex:` vocabulary supplies
application metadata such as version, changed, alias, opposite, and journal
fields. Stable sample IRIs are independent of labels. Original aliases
continue to resolve after the sample rename. The probe does not implement
derived paths or descendant alias regeneration from the current editor.

Each scenario has a current graph, a history graph, and immutable full-copy
version graphs. A single conditional `DELETE / INSERT / WHERE` operation:

1. Replaces the label and revision number in the current graph.
2. Adds a request-specific journal receipt with old/new labels and version.
3. Writes the new full graph snapshot.

The receipt matters because an HTTP success for SPARQL Update does not say
whether a conditional update matched anything. A follow-up query checks the
request's receipt rather than interpreting HTTP 200/204 as “edit applied.”

This demonstrates **application-managed** history, not a built-in Oxigraph
time-travel feature. Full-copy snapshots cost roughly terms × versions and
are deliberately a simple baseline. A production design should compare
per-term revisions with periodic graph snapshots before choosing a format.

The rollback probe inserts a marker, then deliberately attempts to create
an already existing graph in the same request. The server returns 500, and
a subsequent query confirms the marker was not committed. This exercises
runtime rollback rather than just rejection of malformed SPARQL.

Set expansion is expressed directly through SPARQL property paths and
`FILTER NOT EXISTS`. Bounded traversal uses explicit one-step/two-step
unions; SPARQL 1.1 does not provide a general `{min,max}` path quantifier.
A production recipe builder would still need to generate and validate those
queries, apply scheme boundaries, and define exact inclusion semantics.

## Recommendation

**Oxigraph is a promising store for this taxonomy if all mutations go through
one controlled writer. It is not a safe direct-write replacement for the
current application under the tested concurrent-edit protocol.**

It provides useful graph traversal, querying, RDF parsing/serialization, and
HTTP interfaces. The experiment needed no custom graph traversal engine or
RDF parser. It still needed application history, revision handling, write
coordination, and hierarchy rules.

For a future backend adapter, keep the existing editor and domain API, and
route writes through one application process that validates and serializes
them. A process-local queue is sufficient only while that process is the
exclusive writer: additional processes, the Oxigraph console, or direct
SPARQL updates can bypass it. Multi-process writers need a separately
validated coordination design; the server's update condition alone is not
sufficient based on this test.

The fixture also deliberately inserted a hierarchy cycle and a second parent
in a tree scheme. Oxigraph accepted it; SPARQL then detected both problems.
Validation must therefore be integrated with the controlled mutation path,
not assumed from SKOS predicates.

Keep the current SQLite backend as the working application until an adapter
passes equivalent domain tests. This probe does **not** establish production
performance, durability after server restart/crash, network-failure recovery,
authentication, complete recipe semantics, or feature parity for structural
verbs. No server restart or configuration changes were attempted.

## References

- [Oxigraph HTTP and Graph Store interfaces](https://github.com/oxigraph/oxigraph/tree/main/cli)
- [Oxigraph 0.5.13 Store documentation](https://docs.rs/oxigraph/0.5.13/oxigraph/store/struct.Store.html): documents repeatable-read isolation; that is distinct from serializable competing writes.
- [SPARQL property paths](https://www.w3.org/TR/sparql11-query/#propertypaths)
- [SKOS reference](https://www.w3.org/TR/skos-reference/)
