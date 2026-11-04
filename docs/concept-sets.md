# Concept sets and SKOS collections

Open **Concept sets** in the top navigation (`/sets`). Each set belongs to one
scheme and has a stable `s_…` ID, a scheme-unique slug, name, description, owner,
and kind (theme, profile, or map view). Owner is descriptive metadata; per-owner
permissions and consumer subscriptions remain future work.

## Editing and expansion

Choose **Explicit members** to pick terms or other sets in the same scheme.
Enable **Ordered collection** and use the arrows to arrange members. Collections
may nest up to 40 levels; cycles, duplicate members, and missing references are
rejected. Expansion flattens nested collections and removes duplicate terms at
their first encounter. Unordered results sort by label and ID.

Choose **Recipe** to combine:

- **Include concepts**: named terms.
- **Include descendants of**: all narrower levels, excluding the anchor unless
  it is also explicitly included. Polyhierarchies are traversed once per term.
- **Related neighbourhoods**: the anchor plus concepts reachable within depth
  0–10 through the selected types, any of `broader`, `narrower`, `related` and
  `opposite`. `broader` steps up to broader concepts and `narrower` down to
  narrower ones; `related` and `opposite` are followed in either direction. The
  walk stays within the set's scheme.
- **Exclude concepts**: explicit exclusions applied after combining inclusions.

Recipes omit retired concepts and warn about retained retired references. An
explicit collection retains retired members, with a warning, so curated choices
remain visible for review. Recipes have no explicit member list or ordering;
explicit collections can contain recipe sets.

**Preview changes** shows the expansion and additions/removals against the saved
set's current expansion. **Save set** applies the exact previewed definition.
Changing the draft invalidates its preview. A concurrent workspace edit rejects
the save; **Discard** reloads the current workspace. This baseline is the saved
set, not a separate publication workflow. Historical reads and exports pin both
the definition and the vocabulary to the same changelog version.

Delete retains history and the stable ID as a tombstone. A set referenced by a
parent collection must first be removed from that parent's members.
Its source IRI remains reserved after deletion and cannot be reassigned to a
new set, term, or scheme.

## Assigning a term to collections

The vocabulary term editor has a **Concept sets / collections** section. Select
one or more explicit collections in the term's scheme and use **Save changes**.
The term fields and changed collections share one transaction and changelog
revision. Existing ordering is preserved; newly assigned terms append to ordered
collections. Removing a direct membership asks for confirmation.

Recipe membership and inclusion through nested collections are shown separately
at the displayed workspace version. They follow their definitions and cannot be
removed by unchecking a direct-membership checkbox. Use **Manage collections**
to edit those definitions. A term can have both direct and nested membership
in the same collection.

Membership edits check both the term revision and workspace version to prevent
overwriting another collection editor. A conflict retains the unsaved form.
Ordinary term edits that leave membership unchanged do not send assignments or
overwrite concurrent collection changes. Historical membership reads remain
available through `GET /api/terms/:id/collections?at=N`.

For API clients, term PATCH accepts optional `collections: [setId, …]` and
`expectedVersion` alongside `expectedChanged` and the editable term fields.
`collections` is the complete desired list of direct explicit memberships in
that scheme. Providing it requires `expectedVersion`; omitting it preserves
memberships. Collection IDs cannot refer to recipes, deleted sets, or another
scheme. Collections are separate resources and are not stored in the term body.

## Structural changes

Move, Merge, Split, and Retire previews list affected sets, including indirect
membership and changes to recipe expansions. Merge transfers direct members and
recipe references to the surviving target and removes duplicate references.
Those definition changes share the structural operation's changelog number and
transaction. Split and Retire retain references to the retired concept for
review, without automatically selecting replacements. Explicit membership is
unchanged by a move; recipes reflect the new hierarchy. Historical expansions
continue to use the original definitions and term revisions.

## SKOS interchange

The taxonomy page's **Import SKOS…** imports collections alongside a **new
scheme**, from Turtle or a read-only SPARQL query endpoint. The scheme export
(on either page) includes its concepts and collections. Import currently does
not add standalone collections to an existing scheme or synchronize updates.

| Application | RDF |
|---|---|
| Explicit set | `skos:Collection` |
| Ordered set | `skos:OrderedCollection`, `skos:memberList` with an RDF list |
| Members (terms or nested collections) | `skos:member` |
| Label | `skos:prefLabel`, with `rdfs:label` accepted as a fallback |
| Description | `dct:description` |
| Slug, owner, kind, containing scheme | `term:slug`, `term:owner`, `term:kind`, `term:scheme` |
| Recipe | Expanded `skos:member` values plus `term:recipe` |

Here `term:` is `urn:terminology-mcp:vocab:`. A recipe is an application feature;
standard SKOS consumers see its expanded membership. The recipe extension is a
JSON literal whose references use concept IRIs, allowing this application to
round-trip the definition without carrying local IDs. Empty collections use
`term:scheme` to identify their owning scheme. Other collections are discovered
by membership in the selected scheme, including parent and nested collections.
Generated collection IRIs are `urn:terminology-mcp:set:<id>`; imported collection
IRIs are preserved. Missing labels fall back to the source IRI; imported slugs
are generated when absent.

Collections require named IRIs and same-scheme term/collection members. Invalid,
cyclic, forked or incomplete RDF lists, multiple member lists, duplicate members,
and collection/concept identity conflicts are rejected atomically. An ordered
collection's explicit members must all occur in its member list. Collections
are separate resources from concepts and do not become taxonomy parents.

## API and persistence

- `GET /api/sets?scheme=cc-subjects&at=N`: list sets.
- `GET /api/sets/:id?at=N`: read a definition.
- `GET /api/sets/:id/expand?at=N`: definition, terms, warnings, and version.
- `POST /api/sets/preview`: preview creation without writing.
- `POST /api/sets/:id/preview`: preview editing without writing.
- `POST /api/sets`: create; `PATCH /api/sets/:id`: edit.
- `DELETE /api/sets/:id`: delete while preserving historical reads.

Writes and previews accept `{set, expectedVersion}`; deletion accepts
`{expectedVersion}`. The definition uses `members: [termOrSetId, …]`, or a
`recipe: {concepts: [], narrower: [], around: [{term, depth, types}], exclude: []}`.
Set history uses the existing global sequence, with `set-added`, `set-changed`,
and `set-deleted` entries and immutable set revisions.

Database schema version 2 adds set tables without rewriting existing terms or
history. Versions before this feature cannot open a version-2 database. A
manual downgrade needs the pre-deployment backup; the deployer retains that
backup and does not automatically overwrite live data during recovery.

Validation: `npm test`, `npm run test:ui`, and `npm run test:oxigraph-import`.
The Oxigraph check uses isolated disposable graphs and an isolated SQLite DB.
