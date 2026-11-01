# Concept graphs

A concept scheme can be a **Tree**, **Polyhierarchy**, or **Concept graph**.
Graph schemes use an alphabetical concept list rather than forcing the network
into an outline. Concepts may be disconnected, share labels, have several
broader concepts, and participate in cycles of associative relationships.
Broader/narrower links remain acyclic so narrower traversal and structural
operations have a defined meaning. Stable IDs distinguish homonymous concepts.

The four supported relationship types match quote-mcp:

- `broader`: from a concept to a broader concept.
- `narrower`: the inverse direction of `broader`.
- `related`: symmetric; may connect concepts in different schemes.
- `opposite`: symmetric; within a scheme. quote-mcp's `inverse` imports as this type.

Named custom predicates, OWL inference, and live consumer synchronization are
not part of this milestone. A graph is separate from a SKOS collection: a
collection selects concepts; a graph includes the relationships between them.

## Authoring and navigation

Create a scheme and choose **Concept graph**, then add concepts without needing
a root. The vocabulary editor shows each concept's broader, narrower, related,
and opposite connections, including links stored on another concept. Following
a connection opens that concept; **Explore graph** opens its neighbourhood.

The **Concept graph** page (`/graph`) works with all scheme types. Search for a
concept, select a node or connection, choose the traversal depth and relationship
types, or use Enter/Space on a diagram node. The diagram shows at most 150 nodes
and reports truncation; the API and JSON export retain the complete graph.
Disconnected concepts remain in the search list. Arrows point toward broader
concepts; related links are blue and opposite links are dashed amber.

The diagram uses a force-directed layout ([d3-force](https://d3js.org/d3-force)):

- **Starting point:** the selected concept stays at the centre. Each branch
  starts as a radial tree, with a sector sized by the concepts under it.
- **The forces:** links, repulsion and label-sized collision then untangle
  crossings and keep labels apart, while a weak pull holds each depth near its
  own ring.
- **Labels** sit on the outward side of each concept, along its branch.
- **The view** fits the neighbourhood, growing taller for a round one, and
  never draws text larger than its set size.
- **Refocusing** glides from the previous layout to the new one, and concepts
  seen before keep their relative place. With reduced motion requested, the
  diagram is drawn at once.
- **Dragging** a concept pins it under the pointer while the others re-settle
  around it. A drag doesn't select the concept.

The layout is deterministic: the same neighbourhood draws the same way. The
page loads d3-force from the server itself (`/vendor/…`), as the content
security policy allows scripts only from its own origin.

The **Relationship** dropdown offers all four types. For **Broader**, the target
is broader than the selected concept; for **Narrower**, the target is narrower.
Those choices use **Preview relationship**, followed by **Apply change**. The
preview shows parent changes, affected concepts and set effects. Graph and
polyhierarchy schemes preserve other parents; tree schemes explicitly preview
replacement of their single parent. Cycles and stale previews are rejected.
Hierarchy links can also be removed from either endpoint through the same
preview, or edited with **Move** in the vocabulary editor.

Use **Add relationship** for related/opposite links. Either endpoint can remove
a link; both stored directions are changed atomically. Old one-sided links are
read symmetrically too. Each mutation checks the workspace version; **Refresh**
reloads after a conflict and preserves the target selection when it is still
available. Removing a symmetric link from the vocabulary form also removes its
reciprocal copy.

Set recipes can walk `broader` and `narrower` as well as `related` and `opposite`.
The existing **Include descendants of** rule still excludes its anchor; include
that anchor explicitly or use an `around` rule with `narrower` when it belongs
in the result. All expansion and graph reads can be pinned to a changelog version.

## Import and export

**Import graph…** opens the existing preview/apply workflow. Choose a JSON file
in either format:

- `quote-mcp-export/1`: quote-mcp's vocabulary export, including its full export
  containing works/quotes. Only scheme/concept metadata and relationships are
  imported; quote records and works are excluded.
- `terminology-graph/1`: the JSON returned by this server's graph endpoint.

Select a source scheme and a new local scheme ID. **Auto** recommends a structure
from the content and valid source metadata; quote-mcp exports recommend Graph.
The compatibility matrix allows validated overrides. Preview validates the entire selected graph and
reports omissions; apply uses that exact normalized plan and commits atomically.
Missing edge endpoints, ambiguous identities, self-links, unsupported relationship
types, and invalid broader cycles are rejected. Existing local schemes are not
updated or overwritten. Cross-scheme JSON edges require importing the schemes
separately and adding their cross-scheme links explicitly.

| quote-mcp field | Local representation |
|---|---|
| `slug` | Lookup alias `quote-mcp:<source-scheme>:<slug>` |
| Concept identity | `urn:quote-mcp:concept:<scheme>:<slug>` source IRI |
| Scheme identity | `urn:quote-mcp:scheme:<scheme>` source IRI |
| `definition` | Scope note |
| `alt_labels` | Alternative labels |
| `close_match` | External `closeMatch` link when it is an absolute IRI |
| `source` (for example `drupal:kid:44`) | Preserved provenance alias |
| `confirmed` status | `active` |
| `broader` / `narrower` rows | Normalized broader edges; inverse duplicates removed |
| `related` / `inverse` rows | Symmetric related/opposite edges; duplicates removed |

Source identities remain stable when a different local scheme ID is chosen.
Native graph exports retain original source IRIs, aliases, notes, labels,
notations and links when reimported. Node IDs in graph API relationships are
local stable IDs. JSON graph export contains active concepts and their edges;
SKOS export also carries retirement metadata and collections. Use SKOS when
transferring collection definitions alongside a graph.

SKOS Turtle and read-only SPARQL import also accept **Concept graph** as the
scheme structure. They preserve the `skos:related` network and the application's
`term:opposite` links, alongside broader/narrower relations. Graphs do not need
a hierarchical root to import.

## API

- `GET /api/graph?scheme=human-work`: active concepts, directed relationships,
  scheme metadata, and version, in `terminology-graph/1` format.
- `around=<id-or-alias>&depth=1&types=broader,narrower,related,opposite`: select a
  neighbourhood; depth is 0–5. The type filter controls both traversal and edges.
- `set=<set-id>`: restrict to a set's expanded members and induced edges.
- `at=N`: pin both concepts and edges to a historical version.
- `GET /api/sets/:id/graph?at=N`: the expanded set in the same graph shape.
- `GET /api/terms/:id`: includes a `connections` array containing full outgoing
  connections, with derived inverse/symmetric links.
- `POST /api/relations` or `DELETE /api/relations`, with
  `{from, to, type: "related" | "opposite", expectedVersion}`: atomic edge edits.

`broader` and `narrower` appear as paired directed edges. Related and opposite
also appear in both directions, even when stored once. Consumers drawing
undirected lines should deduplicate those pairs. No consumer quote counts are
invented; usage remains a subscriber feature.

Validation covers cyclic associations, disconnected concepts, duplicate labels,
relationship direction, removal through either endpoint, stale edits, historical
reads, graph-shaped sets, JSON/SKOS round-trip, and the browser import/editor.
A compatibility check against quote-mcp's local export imported 221 concepts and
782 directed relationships in an isolated database, preserving psychic prison's
one broader and five related neighbours. The source repository/server were not
modified.
