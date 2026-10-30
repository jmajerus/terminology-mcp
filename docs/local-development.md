# Local development

The local taxonomy workspace implements schemes, terms, structural editing,
SKOS interchange, and history. The main plan in [PLAN.md](../PLAN.md) describes
the larger server and remains the roadmap.

## Structure

- `src/model.ts`: validated inputs and shared domain types.
- `src/store.ts`: SQLite migration, rules, transactions, aliases, and revisions.
- `src/server.ts`: local HTTP routes and static editor assets.
- `src/main.ts`: process startup, database selection, and shutdown.
- `src/seed.ts`: optional demo fixture, imported atomically on an empty store.
- `src/skos.ts`, `src/sparql.ts`: SKOS mapping, RDF serialization, and read-only source queries.
- `public/`: framework-free browser UI, served by the same process as the API.

The store owns the domain rules. Future MCP tools and consumer endpoints can
call it without depending on the browser. No frontend build or CDN is needed.
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
Schemes are immutable after creation in this milestone and filtered by their
creation version. Future scheme edits will need scheme revisions too.

Term IDs are `t_` followed by a random UUID rendered as 32 hexadecimal
characters. They never depend on labels or positions. Tree aliases are
scheme-qualified paths, for example `subjects:politics/public-opinion`.
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
| GET | `/api/state?at=N` | Schemes and terms at N, including derived hierarchy |
| GET | `/api/terms/:id-or-alias?at=N` | Lookup by stable ID or URL-encoded alias |
| GET | `/api/changes?since=N&term=ID` | Ordered changes after N; optional affected-term filter |
| POST | `/api/schemes` | Create `{id, label, hierarchy, description?, admissionTest?}` |
| POST | `/api/terms` | Create `{scheme, label, broader?, altLabels?, scopeNote?, status?, relations?, links?, aliases?}` |
| PATCH | `/api/terms/:id` | Save all editable fields and `expectedChanged`, with optional `reason` |
| POST | `/api/terms/:id/operations/preview` | Preview move/merge/split/retire, using `expectedVersion` |
| POST | `/api/terms/:id/operations/apply` | Apply an explicit structural operation at its previewed version |
| GET | `/api/schemes/:id/skos?at=N` | Download versioned SKOS Turtle |
| POST | `/api/imports/schemes` | Discover schemes in a Turtle payload or SPARQL source |
| POST | `/api/imports/preview` | Parse, map and validate a new scheme, returning a frozen import plan |
| POST | `/api/imports/apply` | Atomically apply `{plan, expectedVersion}` |

`at` defaults to the current version; zero is the empty initial state.
Historical reads return `version` for the requested state and `head` for
the current changelog. Aliases resolve as they existed at the requested
version, so future aliases do not leak into old reads. `PATCH` is a full
save of editable fields; omitted collections and notes take their schema
defaults. It cannot change scheme, parents, IDs, source IRI, or aliases. The browser
sends all editable fields on each save.

This is a local API with no authentication. Binding and Host checks restrict
it to loopback names, and cross-origin writes are rejected. Remote hosting,
Access authentication, and consumer access require a later deployment design.

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

Concept sets and expansion are next. Their membership behavior under structural
changes will need explicit treatment. Subscriber usage and gates, MCP, consumer
seed importers, full vocabulary maps/translation, and live consumer connectivity
remain planned. SKOS mapping references are already available; they are distinct
from the planned consumer maps. The demo does not read or modify sibling repositories.
