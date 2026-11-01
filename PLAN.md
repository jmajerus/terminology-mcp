The section below is copied from the corpus-mcp repository's PLAN.md document:

**Stage 3: the master taxonomy server** (working name terminology-mcp,
after FHIR-style terminology servers: code systems, value sets, and concept
maps are close to our schemes, concept sets, and stage 2's mapping). Seeded from the overlay and CC's
taxonomy; CC's export (`export-taxonomy.mjs`, `taxonomySnapshot.js`)
retires. CC's authoring, including its remote MCP, runs on the LAN behind
Access, so it can read a master server on the LAN directly. Anything on
CC's public site or in CI still needs a snapshot CC checks in. Design
points:

| Area | Decision |
|---|---|
| Ids | Opaque stable ids, the path a derived alias Calibre tags keep using. A path id breaks every consumer's tags when a term moves. |
| Granularity | Each consumer picks its level; deeper tags roll up to the ancestor. "Depth N" means N, or the leaf if shallower; some consumers want a hand-picked set of terms (a profile). CC shows only terms with content. |
| Changes | A published changelog: added, renamed, moved, split, merged, retired, since version X. Generalizes today's retired-with-one-replacement re-tag. |
| Terms | Scope note, alternative labels, optional links to Wikidata or LCSH. Seed scope notes from the Scope column of the domains table in CC's `docs/TAXONOMY-ROADMAP.md`, not CC's `info` texts (player-facing copy CC keeps). Roughly SKOS, which also gives an export format. |
| Top-level terms | The roadmap's admission test, first condition (a real institutional home) as is; its second ("ten puzzles…") is about CC's content, so the master needs its own, e.g. corpus holdings. |
| Proposals | Consumers propose terms; the owner decides. Fits beside `/admin/proposals`. `vocabulary_report` and tag proposals that found no term are the editor's evidence. |
| Puzzle kinds | Leave `trivia` and `vocabulary` out of the subject tree; CC keeps them as local categories with no mapping. Whether they leave CC's navigation is a separate decision. |

**Stage 3: subscribers, impact, and holds** (brainstorm 2026-10-29). How
the master manages its dependents and shows what a proposed change would
break.

- *Additions are free.* Adding a term to a scheme, adding it to a named
  concept set, adding a relation, or editing a scope note goes out to every
  subscriber at once. Renames, moves, merges, splits, retires, and removed
  relations are the breaking kinds, and only those go through the steps
  below.
- *Subscribers and cursors.* The changelog is numbered. Each consumer (CC,
  corpus-mcp, quote-mcp, a Zotero tag sync) registers and keeps an "applied
  through N" cursor. The server notifies on change, but the log is the
  truth: a subscriber that was down catches up from its cursor, the same
  lesson as CC's drain loop.
- *Usage reports.* Subscribers report which term ids they use and how much
  (puzzles, books, quotes, concepts). A proposed breaking change is shown
  with its impact before it's applied ("retire X: CC 4 puzzles, corpus-mcp
  12 books and 30 quotes"). This is the dependency view; without it, a hold
  or a veto has nothing to go on.
- *Holding delivery* (each subscriber alone, always available). A
  subscriber stops advancing its cursor while it's mid-migration; changes
  queue and replay in order on release. Nobody else waits.
- *Gates* (opt-in per subscriber and per change kind). A breaking change is
  proposed first; gate subscribers answer ok or "blocked because…" (CC:
  "this slug is in 40 player URLs"). A veto with a reason, not a lock.
  Consumers that key on ids mostly see renames as label changes; slug-keyed
  consumers (CC's URLs and catalogue ids) are the ones that need a gate.
- *Edit holds* (rare escape hatch). Scoped to a term or subtree, never the
  whole taxonomy; a lease with an owner and an expiry, renewed while
  needed, logged when it lapses. Edits made under a hold are queued as
  pending, not refused. This reverses stage 1's "an unreachable consumer
  never blocks a write" on purpose, which is why it's opt-in and bounded.
- *Relations, not an ontology.* Schemes (topic hierarchies), collections
  (named concept sets, like quote-mcp's sets), broader/narrower, and
  associative links: `related` plus a small, named set of typed relations
  such as quote-mcp's `opposite`. The server stores and serves them and
  does not reason over them (no OWL, no inference); a new relation type is
  a deliberate addition. Full connectivity through these links is the goal
  for concept terms, and feeds graph views like WorkCreatively's.

**Cautions from CC's roadmap.** Its failure mode: "defining the taxonomy
first and growing content into it produces authoring to fill headings."
Terms coined during research are content-driven and fine; filling in
fields ahead of content is not, and is ongoing classification upkeep for
the editor even when players never see empty terms.

**Topic dossier.** The research phase's working set: a (possibly
provisional) term, the books and Zotero items gathered under it, and the
quotes. Since every system shares the term id, it may need no new storage,
only a view across them filtered by that id, read by the authoring server
when planning references.

**Applied taxonomy.** What corpus-mcp alone can publish: each term with its
book counts, pinned citekeys, and tagged quotes, plus the health feed above
for the taxonomy's owner. First consumer: CC's reference planning ("which
books I own can back a puzzle in Political Behavior?").

Related: the manuscript toolkit plan
(`struggle-against-dehumanization/notes/manuscript-toolkit-plan.md`) would
be another consumer, using these terms for what a passage is *about*
alongside IASP for what it *does*.

---

# Outline (2026-10-29)

A first cut at what the server is, borrowing from FHIR terminology where
the fit is real and leaving the rest.

**Implementation update (2026-10-29):** the first local milestone now has a
TypeScript / better-sqlite3 store, a local API, and a working taxonomy editor.
It supports scheme and term creation, field edits, relations, aliases, rename
review, and changelog inspection. Historical term reads use immutable revisions
written atomically with each change; schemes are immutable for now. Stable IDs
use random UUIDs with a `t_` prefix. The demo includes tree and polyhierarchical
fixtures in a separate database. Structural verbs beyond rename, concept sets,
importers, and consumer connectivity remain planned. See
[local development](docs/local-development.md) for the implemented surface.

**Oxigraph feasibility update (2026-10-30):** a separate executable probe
demonstrated SKOS graph queries, recipe-like expansion, RDF round-trip, and
atomic application-managed history on the installed Oxigraph server. A
conditional update alone did not serialize competing writers; an exclusive
application writer remains necessary under the tested design. The SQLite
app is unchanged. See [the experiment and results](docs/oxigraph-feasibility.md).

**Structural editing and interchange update (2026-10-30):** Move, Merge, Split,
and Retire now have transactional previews, stale-preview checks, batch history,
relation transfer, and preserved aliases. The SQLite editor can import new
schemes from Turtle or a read-only SPARQL source and export versioned SKOS
Turtle, including all five SKOS mapping predicates. A dedicated integration
test round-trips through local Oxigraph without changing the app backend.
Concept sets and their expansion remain the next editor milestone. See
[SKOS import/export](docs/skos.md) and [local development](docs/local-development.md).

**MCP read update (2026-10-30):** the editor serves stateless Streamable HTTP
at `/mcp`, sharing the existing store and host/origin protections. Twelve
read-only tools expose schemes, search/lookup, typed graphs, collections and
membership, validation, subsumption, versioned changelog reads and SKOS export.
Agents can pin every read to a changelog version. Proposals, consumer usage,
subscriber cursors, roll-up and translation remain planned. See [MCP access](docs/mcp.md).

**Import and membership update (2026-10-30):** imports default to Auto, honour
compatible source declarations, explain recommendations, and expose a structural
compatibility matrix with validated overrides. Term editing can assign multiple
explicit collections in the same transaction/revision as field changes; recipe
and nested membership remain calculated. See [SKOS](docs/skos.md) and
[concept sets](docs/concept-sets.md).

**Concept-graph update (2026-10-30):** concept networks are first-class scheme
structures with flat authoring, an interactive neighbourhood explorer, symmetric
edge editing, graph-shaped API/set reads, and quote-mcp/native JSON import.
The quote-mcp compatibility check preserves its 221 concepts and 782 directed
relationships, rather than reducing the source to a hierarchy. See
[concept graphs](docs/concept-graphs.md).

**Concept-set update (2026-10-30):** the second editor page now supports explicit,
ordered, nested and recipe sets with immutable revisions and version-pinned
expansion. Structural previews include set effects; merges update membership
and recipe references atomically. Scheme import/export carries SKOS collections
and RDF lists through files and local Oxigraph. See [concept sets](docs/concept-sets.md).
Consumer subscribers and usage intake are the next milestone.

**Subscriber feed update (2026-10-31):** every term has a server-minted slug
(Concept Clusters' rule), unique among siblings and at each depth a tree
scheme lists in `slugUniqueDepths`. Renames keep it; **Change slug…** is a
breaking `slugged` change that keeps the old value in `formerSlugs`. A slug
lookup resolves current and former slugs. `/api/state`, `/api/changes` and the
MCP `get_changes` tool take a `scheme` filter and return a `log` id, so a
consumer can bootstrap, follow the log from its own cursor, and detect a
rebuilt store. Proxied and public requests need a Cloudflare Access assertion.
Concept Clusters' subjects tree is imported as `cc-subjects`. Server-side
subscriber registration, usage, gates and proposals are next. See
[following changes](docs/following-changes.md).

## What we borrow from FHIR

FHIR's terminology module (CodeSystem, ValueSet, ConceptMap, and a handful
of operations) solved the problems we have: stable codes, sets defined by
rule rather than by list, versioned expansions, and maps between
vocabularies. We take its *model and operations*, not its wire format.

| FHIR | Here | Notes |
|---|---|---|
| CodeSystem | **Scheme** | A named vocabulary: `cc-subjects` (the topic tree CC and corpus-mcp share), `human-work` (quote-mcp's concepts). A scheme declares its hierarchy: `tree` (one broader term; paths exist) or `poly` (several broader terms; no paths). |
| concept `code` | term **id** | Opaque and stable (`t_8k2q…`). Never reused, never changed. |
| `display` | `label` | The preferred label. |
| `definition` | `scopeNote` | What belongs here and what doesn't. Not player copy. |
| `designation` | `altLabels`, plus aliases | Alternative labels for search; aliases (`path`, old slugs) resolve to the id. |
| concept `property` | `status`, `links`, … | `links`: Wikidata, LCSH, as SKOS `exactMatch`/`closeMatch`. |
| ValueSet | **Concept set** | Named, owned, either a list or a recipe (below). Consumer profiles are concept sets too. |
| `compose.include` / `exclude` / `filter` | set recipe | quote-mcp's `concepts`, `narrower`, `around`+`depth`+`types`, `exclude` already are this; adopt them as-is. |
| `$expand` | `expand` | A set's terms at a version. Intensional sets pick up new terms on their own. |
| `$lookup` | `lookup` | A term by id or any alias, with relations and status; a retired term answers with its replacements. |
| `$validate-code` | `validate` | Is this id active, and in this set? If not, what replaces it? |
| `$subsumes` | `subsumes` | Is A under B? The basis for roll-up. |
| ConceptMap | **Map** | CC category ↔ term (stage 2), Calibre tag paths, quote-mcp's old slugs. Equivalence: `equal`, `broader`, `narrower`, `related`. |
| `$translate` | `translate` | Through a map, either direction. |
| CodeSystem `version` | changelog number | One sequence for the whole server; every read can be pinned to it. |
| publication `status` | term `status` | `provisional`, `active`, `retired` (with `replacedBy`). corpus-mcp's `superseded` becomes `retired` + replacement. |

**Left out:** FHIR's JSON resources and canonical URLs as the API (we can
emit a FHIR-shaped export later if anything wants it), multilingual
designations, `TerminologyCapabilities`, post-coordination, closure tables
as a client protocol, and any inference. SKOS stays the export format; it
is the closer fit for scope notes and associative links.

**Added beyond FHIR:** the numbered changelog with subscriber cursors, usage
reports, gates and holds (above), typed associative relations (`related`,
`opposite`, …), and roll-up (`rollup(id, depth | set)`: the term a consumer
should show for a deeper one).

## Resources

- **Term**: `id`, `scheme`, `label`, `altLabels[]`, `notations[]`,
  `scopeNote`, `status`, `broader[]` (one in a tree scheme), `relations[]`
  (`{type, target}`; only `related` may target another scheme), `links[]`,
  `aliases[]`, `slug`, `formerSlugs[]`, `replacedBy[]`, `sourceUri`,
  `created`/`changed` (changelog numbers).
  Derived: `path` (tree schemes), `depth`, `narrower[]`, usage counts.
- **Scheme**: `id`, `label`, `description`, `hierarchy`, top terms,
  admission test text. The top terms of `cc-subjects` are CC's domains.
- **Concept set**: `id`, `slug`, `label`, `description`, `owner`
  (a subscriber or the editor), `kind` (`theme`, `profile`, `map-view`),
  and either `members[]` or a recipe. Every set is in one scheme.
- **Map** (planned): `source` system, `target` scheme, rows of
  `{from, to, equivalence, note}`.
- **Change**: `n`, `kind` (`scheme-added`, `imported`, `added`,
  `labelled`, `noted`, `updated`, `moved`, `merged`, `split`, `retired`,
  `slugged`, `set-added`, `set-changed`, `set-deleted`; relation edits are
  `updated`), `terms`, before/after with snapshots of every affected term
  and set, `breaking`, `author`, `reason`, `at`. Proposals (planned) are
  changes with no `n` yet.
- **Subscriber** (planned; today each consumer keeps its own cursor): `id`, `cursor`, `usage` (term id → counts by kind),
  `gates` (change kinds it answers), `hold` (a lease, when set).

## Surfaces

- **REST** (`/api/…`), for consumers and the editor: lookup, expand,
  `changes?since=N` and slug lookup today; validate, subsumes, translate,
  rollup, usage intake, proposals and gate answers to come. Read endpoints
  are cacheable by version.
- **MCP**, for agents: the read operations (done) plus `propose_term` and
  `propose_change` (planned). Agents propose; only the editor applies
  breaking changes.
- **Exports**: SKOS Turtle per scheme (done; JSON-LD not yet); a snapshot
  file for consumers that can't reach the LAN (CC's public site, CI).
- **Editor**: two pages, below, plus a concept-graph explorer.

Same stack as corpus-mcp and quote-mcp: TypeScript, better-sqlite3, the MCP
SDK, zod, Access JWTs (`jose`). Runs on the LAN behind Access.

## The editor

CC's category editor edits one category document at a time, with
subcategories nested inside it, so the tree as a whole is never in view
and a move is an edit to two documents. The new editor is built around the
whole tree and the changelog instead.

**Page 1: Taxonomy** (`/edit/schemes/<scheme>`). Three panes:

- *Outline*: the full tree, keyboard-first like an outliner (arrows,
  Tab/Shift-Tab to move under/out, Enter for a new sibling, `/` to filter).
  Each row shows usage as a small bar per subscriber, status as a mark
  (provisional dashed, retired struck), and terms with no usage dimmed, not
  hidden. Drag to move.
- *Term*: label, alt labels, scope note, links, relations (typed chips,
  searchable), aliases, and the term's history from the changelog. Breaking
  actions are named verbs, not field edits: **Move**, **Merge into…**,
  **Split…**, **Retire…** (with replacement).
- *Changes tray*: free edits apply at once and land here as applied; a
  breaking verb opens a pending change with its impact ("CC 4 puzzles;
  corpus-mcp 12 books, 30 quotes"), gate answers as they come in, and
  Apply / Discard. Proposals from consumers arrive in the same tray with
  their evidence (`vocabulary_report` hits, unmatched tag proposals).

**Page 2: Concept sets** (`/edit/sets/<set>`). Three panes:

- *Sets*: list grouped by kind (themes, profiles, map views), with owner and
  size.
- *Definition*: the recipe as rows ("include narrower of *Political
  Behavior*", "include around *despair*, depth 1, related + opposite",
  "exclude *pain*"), or a plain member list for an extensional set. A term
  picker with tree context, not a slug field.
- *Expansion*: the live result, shown as the tree with members marked, the
  count, and a diff against the last published expansion ("+3 −1 since
  N"), so a recipe change shows exactly which terms it pulls in.

## Order of work

1. Store and model: terms, schemes, changelog, aliases. *Done.* Seeds
   came in through SKOS and graph import rather than per-consumer importers:
   CC's tree is in as `cc-subjects`, and **Import graph…** reads quote-mcp's
   export. corpus-mcp's overlay is still to come.
2. Read API: lookup, expand, validate, subsumes, changes. *Done*; rollup
   is still to come.
3. Editor page 1 (taxonomy) with free edits and the four breaking verbs,
   applying directly (no subscribers yet). *Done*, with **Change slug…**.
4. Editor page 2 (concept sets). *Done*, plus the concept-graph page.
5. Subscribers: cursors, usage intake, impact on pending changes. *Started*:
   the scheme-filtered feed with a log id works with consumer-held cursors.
6. MCP surface and proposals. *Read tools done*; proposals to come.
7. Gates and holds.
8. Exports (SKOS, consumer snapshot); maps and `translate` once CC's
   stage 2 mapping exists. *SKOS done*; the rest to come.

## Decided

- *Cross-scheme relations, as a trial* (2026-10-29). A `human-work`
  concept may be `related` to a `cc-subjects` term, and the reverse; it is
  what connects the graph. Typed relations other than `related` stay
  within a scheme for now. The cost: retiring or merging a term must
  carry its relations from other schemes, and its impact must count
  them, so the editor shows them on the term like any other relation.
  Review after the seed import: keep it if the links get used, otherwise
  drop the cross-scheme ones (each is a logged `unrelated` change).
- *CC's domains are the top terms of `cc-subjects`* (2026-10-29), not a
  scheme of their own: they are the subject tree's top level, and CC
  hard-codes them only because nothing held them. Seed them from CC's
  `puzzles/domains.js` (13 today), keeping the ids as CC aliases
  (`cc-domain:sciences-mathematics`). The roadmap's admission test is
  the scheme's rule for top terms, and the consolidation the
  `domains.js` comments describe (five science domains merged into two,
  "split back out once real content … justifies the finer grain") is an
  ordinary split when it comes. CC's generated `other` domain stays
  CC-local, like the puzzle kinds. This revises stage 2's "CC's DOMAINS
  stay CC's own navigation layer": the layer stays, but its ids and
  labels come from the master, and `domains.js` becomes a snapshot or
  goes. CC's `domain-<id>` catalogue ids and URLs are slug-keyed, so CC
  should gate breaking changes on top terms. The `info` texts stay as
  CC's player copy.

- *Concept Clusters' subjects come from here; LCC is linked, not
  flattened* (2026-10-31). The Concept Clusters side is in its
  [subjects-from-terminology-mcp](https://github.com/jmajerus/concept-clusters/blob/main/docs/dev-briefs/subjects-from-terminology-mcp.md)
  dev-brief.
  - **Seed:** done. The tree was imported with **Import SKOS…** from
    `http://oxigraph.localdomain:7878/query`, named graph
    `urn:concept-clusters:graph:subjects`, as the scheme `cc-subjects`
    (tree, `slugUniqueDepths` [0, 1]). It holds 13 domains, 56 categories
    and 117 subcategories with `cc-*` aliases and Concept Clusters' slugs.
    This server is now the master: a re-import answers 409, so a domain,
    category or subcategory is added here, by hand, and Concept Clusters
    picks it up from the changelog.
  - **Feed:** Concept Clusters bootstraps from
    `/api/state?scheme=cc-subjects` and follows
    `/api/changes?since=N&scheme=cc-subjects`, keeping the `log` id beside
    its cursor. Slugs, the scheme filter and the log id are implemented.
  - **Depth:** `cc-subjects` stays three levels deep, matching what Concept
    Clusters shows.
  - **LCC:** the classification is a shelving scheme, and its depth means
    different things in different branches. A `cc-subjects` term links to the
    LCC class that fits, at any depth, with `closeMatch` or `broadMatch`.
    A new subcategory is promoted from one LCC class at a time (see
    [linking to LCC](docs/local-development.md#linking-cc-subjects-to-lcc)).
  - **Proposals:** a proposed term is `provisional` and usable by Concept
    Clusters at once, on published puzzles too. The owner confirms,
    merges or retires it from the changes tray.
  - **Player copy:** Concept Clusters keeps its category editor, narrowed
    to player copy (`info` texts, wiki links).

## Open questions

- Does a profile's depth rule live in the set (a `depth` filter) or in the
  consumer's subscription?
- Ids resolved in the first milestone: random `t_` + UUID hexadecimal;
  no sequential or path-derived identities.
