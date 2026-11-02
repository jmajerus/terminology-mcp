# Local development

The local taxonomy workspace implements schemes, terms, structural editing,
SKOS interchange, and history. The main plan in [PLAN.md](../PLAN.md) describes
the larger server and remains the roadmap.

The same HTTP service provides fourteen MCP tools at `/mcp`, all read-only
except `propose_term`, using
stateless Streamable HTTP. See [MCP access](mcp.md) for client configuration,
version-pinned paging and the available operations.

## Structure

- `src/model.ts`: validated inputs and shared domain types.
- `src/store.ts`: SQLite migration, rules, transactions, aliases, and revisions.
- `src/server.ts`: local HTTP routes and static editor assets.
- `src/main.ts`: process startup, database selection, and shutdown.
- `src/seed.ts`: optional demo fixture, imported atomically on an empty store.
- `src/skos.ts`, `src/sparql.ts`: SKOS mapping, RDF serialization, and read-only source queries.
- `src/mcp.ts`: the MCP tools served at `/mcp`.
- `src/access.ts`: Cloudflare Access assertion checks for proxied and public requests.
- `public/`: framework-free browser UI, served by the same process as the API.

The store owns the domain rules. The HTTP API, the MCP tools and the editor
all call it, so none of them depends on the browser. No frontend build or CDN is needed.
`npm run dev` watches the TypeScript server; refresh the browser after frontend
changes. `npm run build` emits server JavaScript into `dist/`; run that build
with `node dist/main.js` from the repository, retaining `public/` alongside it.

## Storage and history

SQLite uses foreign keys, WAL mode, a busy timeout, and `PRAGMA user_version`
for schema migrations. Database files are ignored by Git. Stop the process
before copying a database for backup; retain the WAL and SHM sidecars if they
remain after shutdown. Do not copy just the main file while a writer runs.

Each applied mutation writes the current term, an immutable term revision,
aliases, and its numbered changelog entry in **one transaction**. A failed
validation or alias collision rolls back the entire operation. A no-op save
does not advance the changelog. Revisions are full term snapshots rather
than event replay; historical reads select the last revision at or before N.
Schemes have revisions too. Only the maximum depth can change after creation:
**Depth limit** in the outline (or `PATCH /api/schemes/:id`) logs a
`scheme-changed` change, and every active or provisional term must already fit
the new limit. Retired terms are exempt: they are read-only and keep the place
they retired from. Once set, adding, moving or importing a term deeper than
the limit is refused, and
**+ Narrower term** is disabled at the limit. Top terms are depth 0, so
`cc-subjects` uses 2 for domains, categories and subcategories.

Term IDs are `t_` followed by a random UUID rendered as 32 hexadecimal
characters. They never depend on labels or positions. Tree aliases are
scheme-qualified paths, for example `cc-subjects:politics/public-opinion`.
A rename keeps all existing aliases and adds the newly derived paths for
the term and its descendants. Descendant revisions share the rename's
changelog number. Reusing a historical path for a different term is rejected.
Path segments preserve Unicode letters, numbers, and combining marks. Moves
and renames record descendant path/depth changes even when returning to an
existing alias, so descendant revision checks and impact history remain accurate.

Tree schemes accept one broader term; polyhierarchies accept several and
have no derived path. Depth starts at zero; for a polyhierarchy it is the
shortest distance to a root. Broader terms must exist in the same scheme.
Parent links change only through explicit structural operations. Whole-graph
validation rejects hierarchy and replacement cycles. Sibling labels that
normalize to the same path segment are rejected. The depth limit uses the
longest path for hierarchy and replacement validation, regardless of input order;
paths with 500 edges are accepted, and longer ones are rejected.

The outline expands each concept's descendants once. Repeated occurrences in
a polyhierarchy are selectable shared references. Rendering stops at 5,000
rows with a prompt to filter, preventing a large graph from freezing the editor.

Relations are explicit typed edges. `related` can cross schemes; `opposite`
stays within one scheme. Self-relations and duplicate outgoing edges are
rejected. The editor displays incoming edges too, linking to their source
term for editing. No inverse edges or inferred relations are stored.
External references support absolute IRIs and all five SKOS mapping types.
See [SKOS interchange](skos.md) for supported fields and import limits.

Every edit sends `expectedChanged`. If another edit changed that term,
the server returns 409, and the UI retains the unsaved text. Renames and
removed relations are marked breaking and reviewed before applying locally.
Subscriber usage remains unknown until reporting is implemented.

## Structural operations

Move, merge, split, and retire have separate preview and apply endpoints.
Preview executes the complete operation in a rolled-back SQLite transaction,
including validation and alias-conflict checks. Apply checks the global
`expectedVersion`, regenerates the operation, and commits it as one numbered
change with before/after snapshots of every affected term.

- **Move** changes broader terms and derives new aliases for the term and its
  descendants. All old aliases remain reserved.
- **Merge** retires the source with the target as replacement, reparents its
  children, redirects incoming relations (including cross-scheme ones), and
  transfers outgoing relations, alternative labels, and external references.
- **Split** creates two or more replacements at the same hierarchy position.
  Every direct child needs an explicit replacement assignment. Incoming and
  outgoing relations are copied to all replacements; the preview shows these
  effects. The source retires, retaining its original identity and metadata.
- **Retire** optionally records replacements. Children move to the source's
  former broader terms. Incoming/outgoing relations transfer to replacements;
  without replacements incoming edges are removed. The changelog preserves
  the removed edges. Retired terms are read-only.

A merge or retirement replacement cannot be a descendant of the source.
Replacement chains remain available when a replacement itself retires later.
The UI exposes the replacement links rather than silently redirecting IDs.

## Local API

All writes accept `application/json`; validation failures return 422,
conflicts 409, and missing resources 404, with `{ "error": "…" }` bodies.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/state?at=N&scheme=ID` | Schemes, terms and sets at N, including derived hierarchy; optional scheme filter |
| GET | `/api/terms/:id-or-alias?at=N` | Lookup by stable ID or URL-encoded alias |
| GET | `/api/changes?since=N&term=ID&scheme=ID` | Ordered changes after N; optional affected-term and scheme filters (unknown scheme: 404) |
| GET | `/api/schemes/:id/slugs/:slug?parent=REF&depth=D&at=N` | Resolve a current or former slug; `parent` (ID, alias or slug) or `depth` narrows it |
| POST | `/api/schemes` | Create `{id, label, hierarchy, description?, admissionTest?, slugUniqueDepths?, maxDepth?, slugScope?, proposalSource?}` |
| PATCH | `/api/schemes/:id` | Change settings `{maxDepth?, slugScope?, proposalSource?, expectedVersion}`; settings left out keep their value, and `maxDepth: null` removes the limit |
| POST | `/api/proposals` | Propose a provisional term `{scheme, broader?, source?, sourceScheme?, match?, label?, proposer, scopeNote?, altLabels?, slug?, evidence?, requestId?}`, copied from a term in another scheme. `broader` is optional only in a concept graph; `source` only where the scheme's `proposalSource` is `optional`, with `label` and `evidence` instead |
| POST | `/api/subscribers/:id/progress` | Report `{log, through, schemes?, label?, blocked?, reset?}` |
| GET | `/api/subscribers`, `/api/subscribers/:id` | Each subscriber's progress, pending changes and hold |
| POST | `/api/terms` | Create `{scheme, label, broader?, altLabels?, scopeNote?, status?, relations?, links?, aliases?, slug?, source?}`; `source: {ref, scheme?, match?}` names the term in another scheme it was copied from |
| PATCH | `/api/terms/:id` | Save all editable fields and `expectedChanged`, with optional `reason` |
| POST | `/api/terms/:id/operations/preview` | Preview move/merge/split/retire/slug, using `expectedVersion` |
| POST | `/api/terms/:id/operations/apply` | Apply an explicit structural operation at its previewed version |
| GET | `/api/schemes/:id/skos?at=N` | Download versioned SKOS Turtle |
| POST | `/api/imports/schemes` | Discover schemes in a Turtle payload or SPARQL source |
| POST | `/api/imports/preview` | Parse, map and validate a new scheme, returning a frozen import plan |
| POST | `/api/imports/apply` | Atomically apply `{plan, expectedVersion}` |

`/api/state` and `/api/changes` also return `log`, a random ID created with
the store. A subscriber saves it beside its cursor; a different `log` means
the store was rebuilt and the subscriber must bootstrap again from
`/api/state`. A `since` beyond the head returns 400.

Every term has a `slug`, minted once from its label at creation (Concept
Clusters' rule, with diacritics folded) or taken from the request or SKOS
`urn:terminology-mcp:vocab:slug`. Renames never change it. Slugs are unique
among siblings, and scheme-wide at each depth a tree scheme lists in
`slugUniqueDepths` (SKOS `vocab:slugUniqueDepth`); each listed depth is its
own scope. A scheme with `slugScope: "scheme"` (SKOS `vocab:slugScope`) has
one scope instead, the whole scheme, and takes no slug depths. Switching an
existing scheme to it drops its slug depths, which the wider scope covers, and
is refused while two of its terms share a slug or former slug. Minted slugs take `-2`, `-3`, … on collision, while explicit slugs
that collide are refused. The `slug` operation changes a slug as a breaking
`slugged` change; the old value moves to `formerSlugs`, stays reserved in the
same scopes, and still resolves through the slug lookup. A `parent` given
as a slug matches every term with that slug, so a slug repeated across
depths still narrows correctly.

### Linking cc-subjects to LCC

A `cc-subjects` term points at the Library of Congress class that fits it,
at any depth, through an external reference.

To add a subcategory from a class, select its category and choose
**+ Narrower term**. In **Copy from another vocabulary**, search by label
or class code (for example `QA76`), and pick the entry. That fills in the
label (edit it if it should read differently) and links the class's
id.loc.gov IRI. Choose how they match: **Close match** by default,
**Broad match** when the class is wider, and **Exact match** only for true
equivalents. Set **Status** to Active unless Concept Clusters should show
it as provisional, and give a **Slug** if Concept Clusters' id differs from
the one minted from the label. **Create** saves the term and its link as
one change, and records the entry it was copied from (its id, scheme, IRI,
label and match) as the term's `source`, the same record an agent's
proposal keeps.

To link an existing term, copy the class's IRI from **Aliases** on the
`loc-classification` term, then add it under **External references** with
**+ Reference** and save. Change a slug that's already in use with
**Change slug…**; Concept Clusters holds on slug changes until you
coordinate them.

The subjects graph can't be imported again (409, "source scheme is
already imported"), so domains, categories and subcategories are added here
by hand.

A change's `breaking` flag means it may break some consumer (renames break
label-keyed ones), not that every subscriber must stop; each subscriber
decides per kind.

`at` defaults to the current version; zero is the empty initial state.
Historical reads return `version` for the requested state and `head` for
the current changelog. Aliases resolve as they existed at the requested
version, so future aliases do not leak into old reads. `PATCH` is a full
save of editable fields; omitted collections and notes take their schema
defaults. The additive `notations` field is an exception: omission preserves
existing codes, while an explicit empty array clears them. It cannot change
scheme, parents, IDs, source IRI, or aliases. The browser
sends all editable fields on each save.

Requests from loopback or the configured LAN hostnames need no credentials.
Development defaults to loopback. The Debian LAN service explicitly sets
`HOST` and `TERMINOLOGY_ORIGINS`; Host and origin checks reject unknown hosts
and cross-origin writes. Proxied and public-host requests need a verified
Cloudflare Access assertion when `ACCESS_TEAM_DOMAIN` is set; see
[deployment](deployment.md) and [MCP access](mcp.md).

## Verification

`npm test` uses temporary SQLite databases and an ephemeral local HTTP port.
It checks history, descendant alias updates, rollback, stale writes,
hierarchy and relation rules, reopen persistence, seeding, API validation,
and request-origin restrictions. It never opens your workspace database.

`npm run test:ui` starts its own server on port 3211 with a temporary database
and shuts it down afterward. Browser checks cover first setup, creating and
editing terms, reload persistence, rename review, relations, references,
history, searching by alternative label, mobile overflow, concurrent tabs,
file import/export, all four structural verbs, and stale structural previews.
Delayed-response tests cover edited forms, closed/reopened dialogs, different
selected terms, and changed import files. Discovery and preview requests carry
generation checks; only a response matching the current form/session can enable
Apply or populate the source selection.
Screenshots and failure traces are written under ignored `test-results/`.

## Next slices

Implemented beyond this page: [concept sets](concept-sets.md) (recipes,
versioned expansion, SKOS collections), [concept graphs](concept-graphs.md),
[MCP tools](mcp.md), and the changelog feed consumers follow
([following changes](following-changes.md)). Concept Clusters' subjects tree
is imported as `cc-subjects`.

Subscribers report their progress and holds, and consumers and agents propose
terms copied from a reference vocabulary ([following changes](following-changes.md)).
A public hostname can serve a read-only view
([deployment](deployment.md#public-read-only)). Still planned: usage
reports and impact counts, gates and holds as leases, `propose_change`,
roll-up, and vocabulary maps with `translate`. SKOS mapping
references are already available; they are distinct from the planned
consumer maps. The demo does not read or modify sibling repositories.
