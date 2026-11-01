# SKOS import and export

SQLite remains the authoritative store. The editor can import a **new scheme**
from a Turtle file or a SPARQL query endpoint, and export any scheme as Turtle.
Importing is a read-only operation on the source server. It is not continuous
synchronization or an update/merge of an existing local scheme.

## Editor workflow

1. Choose **Import SKOS…** in the outline.
2. Select a Turtle file, or enter a SPARQL **query endpoint** and optional
   named graph. For the local server use `http://oxigraph.localdomain:7878/query`.
   An omitted graph uses the endpoint's default graph, not every named graph.
3. Click **Find schemes** and choose a declared `skos:ConceptScheme`.
4. Set a new local scheme ID, target structure (**Auto** by default), and label language.
   The scheme name can be overridden when the source has no preferred name.
5. Click **Preview import**. Review the count, terms, and warnings about data
   that cannot be represented in this application.
6. Click **Import scheme**. A change to the workspace after preview rejects
   the apply and requires a fresh preview.

The source is fetched during preview. Apply uses that exact normalized plan
rather than querying a potentially changed source again. The entire scheme,
its terms, aliases, and changelog records commit together or roll back together.
A successful import records `scheme-added` and one `imported` batch change.
All imported terms share the batch's creation/revision number.
Collections import in the same transaction with a `set-added` batch revision.
Ordered lists, nested collections, and application recipe definitions are
preserved. See [concept sets](concept-sets.md) for mappings and restrictions.

Use **Export SKOS ↓** for the selected scheme. The HTTP endpoint also supports
historical exports via `?at=N`. The export includes retired terms and replacement
metadata, so historical identities remain available. Local stable IDs are never
derived from imported labels or paths.

## Structure recommendations and overrides

**Auto** analyses the normalized concepts and relationships. A valid source
declaration (`term:hierarchy` in SKOS or `hierarchy` in native graph JSON) is
honoured when compatible. Otherwise the importer recommends Tree for a purely
hierarchical single-parent structure, Polyhierarchy for multiple parents, or
Graph for associative networks and colliding path labels. quote-mcp exports
recommend Graph. A flat source without hierarchy is ambiguous and defaults to
Graph; the preview explains that choice. Invalid or conflicting declarations
are reported in the explanation and do not override the content checks.

The preview shows the selected/recommended structure, edge and parent counts,
and a compatibility matrix with concrete examples. Choosing Tree, Polyhierarchy,
or Graph manually overrides the recommendation. Preview again after changing
the selection. An incompatible choice disables Apply, and the server still
validates the complete plan if Apply is called directly.
The preview API returns this matrix as `analysis`; structural incompatibility
returns HTTP 200 with `analysis.compatible: false`. API clients must check that
flag before applying. Other input/identity/reference errors still return errors.

| Content | Tree | Polyhierarchy | Graph |
|---|---|---|---|
| Single-parent acyclic hierarchy | Compatible* | Compatible* | Compatible |
| Multiple broader parents | Incompatible | Compatible* | Compatible |
| Related/opposite relationships, including associative cycles | Preserved | Preserved | Preserved |
| Broader/narrower cycles | Incompatible | Incompatible | Incompatible |
| Disconnected concepts | Allowed | Allowed | Allowed |

\* Tree and Polyhierarchy also reject colliding normalized labels for concepts
with the same broader-parent set. Graph permits those homonymous concepts.

These are structural compatibility checks; source identity, references, term
fields, collections, and workspace conflicts are also validated. No mode drops
associative links, prunes parents, or flattens the source. A lossy conversion to
a tree requires a separately reviewed transformation and is not performed here.

## Field mapping

| Local field | RDF predicate/type | Notes |
| --- | --- | --- |
| Scheme | `skos:ConceptScheme` | Must be explicitly declared on import |
| Term | `skos:Concept` | Import membership is explicit `inScheme`, `topConceptOf`, or scheme `hasTopConcept` |
| Scheme/term label | `skos:prefLabel` | One label in the selected language; untagged fallback |
| Alternative labels | `skos:altLabel` | Selected-language or untagged values |
| Term/scheme notations | `skos:notation` | Literal text, datatype IRI, and optional language tag are preserved |
| Scope note | `skos:scopeNote` | `skos:definition` is a fallback on import |
| Scheme description | `dct:description` | Selected-language or untagged value |
| Scheme membership | `skos:inScheme` | Every local term belongs to one scheme |
| Broader terms | `skos:broader` | Inverse `skos:narrower` assertions are normalized on import |
| Top terms | `skos:hasTopConcept`, `skos:topConceptOf` | Exported for non-retired roots |
| Related | `skos:related` | Incoming edges are recognized too; cross-scheme links require the other term to be imported |
| Opposite | `term:opposite` | Application relation, restricted to one scheme |
| Source identity | Concept/scheme subject IRI | Preserved on export; term source IRI is also a lookup alias |
| Retired replacements | `dct:isReplacedBy` | Distinct from equivalence mappings |
| Status, aliases, hierarchy, admission test | `term:status`, `term:alias`, `term:hierarchy`, `term:admissionTest` | Application extensions |
| Slugs and scheme depth rules | `term:slug`, `term:formerSlug`, `term:slugUniqueDepth`, `term:maxDepth` (integers), `term:slugScope` (`siblings` or `scheme`), `term:proposalSource` (`required` or `optional`) | Application extensions |

Here `dct:` is `http://purl.org/dc/terms/`, and `term:` is
`urn:terminology-mcp:vocab:`. Unimported local concepts export with stable
`urn:terminology-mcp:term:<term-id>` IRIs; local schemes use
`urn:terminology-mcp:scheme:<scheme-id>`. Importing assigns fresh local IDs
and preserves the RDF subject IRIs, rather than accepting remote internal IDs.

All five SKOS mapping predicates are stored as external references:

| Mapping | Meaning of the target relative to this term |
| --- | --- |
| `skos:exactMatch` | Exact match |
| `skos:closeMatch` | Close match |
| `skos:broadMatch` | Broader matching concept |
| `skos:narrowMatch` | Narrower matching concept |
| `skos:relatedMatch` | Associatively matching concept |

Mapping targets remain absolute IRIs, including URNs. They need not already
exist locally and are not dereferenced. A mapping is not treated as identity:
an `exactMatch` target does not automatically become an alias or replacement.
These references can also be edited in the term form.
Incoming mapping assertions are normalized using symmetry for exact/close/related
matches and the broad/narrow inverse pair.

## Notations

Notations are classification codes, separate from preferred/alternative labels,
source IRIs, and lookup aliases. Terms and schemes can have multiple notations.
Each is stored as `{value, datatype, language?}`. Plain RDF strings use
`http://www.w3.org/2001/XMLSchema#string`; custom datatype IRIs identify notation
systems. Values are never trimmed or converted to numbers, so `"001.20"` keeps
its leading zeros. Equal text with different datatypes remains distinct.
Identical literals are deduplicated within a resource; codes are not forced
unique across the scheme.

Turtle and SPARQL imports both preserve notations, independently of the selected
label language. Language-tagged notation literals retain their tags and
`rdf:langString` datatype. Nonliteral notation values are rejected. The editor
can add, edit, remove, and search term notations; scheme codes appear beneath
the scheme selector. Notation edits are versioned and historical SKOS exports
include the values at that version. Merges retain source and target codes;
splits retain codes on the retired source and leave new concepts without codes.

Existing databases need no schema migration. An omitted `notations` field on
term edits preserves existing codes for compatibility with older clients; an
explicit empty array clears them. See the [SKOS notation definition](https://www.w3.org/TR/skos-reference/#notations).

## Validation and limits

The importer rejects ambiguous preferred labels, blank-node concept identities,
multiple scheme memberships (including `inScheme`, `topConceptOf`, and inverse
`hasTopConcept` together), missing broader terms, hierarchy/replacement cycles,
invalid tree cardinality, duplicate identities, and alias collisions. Source IRIs
already imported into the workspace cannot be imported again under a second ID.
The preview reports omitted predicates, unselected languages, and unresolved
associative links. Unknown broader terms are errors rather than omissions.

The current data model is single-language. Import selects the requested language
or untagged fallback, without translating or retaining other-language labels.
Scheme hierarchy is an explicit import choice. This is a supported SKOS profile,
not arbitrary RDF preservation, SKOS-XL support, SHACL validation, or an OWL
reasoner. In particular, it does not enforce every semantic integrity condition
in the full SKOS specification. Associations are not inferred from mapping links.

Files and source responses are limited to 5 MiB, parsed RDF to 100,000 triples,
and imports to 10,000 terms. A hierarchy or replacement path deeper than 500 is
rejected. Individual fields retain the application's normal size limits.
Scheme discovery is capped at 1,000 result rows. Source requests have a timeout
and do not follow redirects. Endpoints must be HTTP(S), without embedded
credentials, query strings, or fragments. Authenticated sources are a later task.

SPARQL queries are generated from validated scheme/graph IRIs. The application
only sends `SELECT` and `CONSTRUCT` to the query endpoint; it never sends source
updates. The `CONSTRUCT` includes selected scheme metadata, member properties,
and inbound hierarchy, related, and mapping statements needed to interpret their inverses.
N3 handles parsing and serialization; there is no custom Turtle parser.

## Local Oxigraph integration test

```sh
npm run test:oxigraph-import
```

Override the server base URL with `OXIGRAPH_URL` if needed. The test creates two
unique sample graphs, runs source discovery/preview/apply through the real app
API and a separate SQLite database, exports back to Oxigraph, and imports that
export again. It checks stable source identities, hierarchy, notes, all five
mapping types, typed term/scheme notation round trips, duplicate rejection, source immutability, and rejection of mixed
memberships asserted through inbound `hasTopConcept`. Both remote graphs
are dropped and their removal verified. It does not open your workspace database.

Reports, request logs, exported Turtle, the sample SQLite database, and exact
cleanup statements are written under ignored `data/oxigraph-import/<UUID>/`.
If cleanup needs retrying, its manifest is compatible with:

```sh
npm run test:oxigraph -- --cleanup data/oxigraph-import/<UUID>/manifest.json
```

Recorded run on 2026-10-30 against **Oxigraph/0.5.13**:
`e40798fd-43b5-42e1-9854-21f6eeaa19b7`. All seven integration checks passed;
both owned graphs were removed and verified. This import use does not require
the concurrent-write coordination discussed in the earlier feasibility report.

References: [SKOS](https://www.w3.org/TR/skos-reference/),
[SPARQL Protocol](https://www.w3.org/TR/sparql11-protocol/),
[N3](https://github.com/rdfjs/N3.js).
