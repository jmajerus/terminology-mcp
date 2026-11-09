# terminology-mcp

The master taxonomy server: one home for the subject terms and concepts that
[concept-clusters](https://github.com/jmajerus/concept-clusters) (CC),
[corpus-mcp](https://github.com/jmajerus/corpus-mcp), and
[quote-mcp](https://github.com/jmajerus/quote-mcp) tag things with today,
each in its own copy. Consumers key on stable term ids, follow a numbered
changelog, and see what a change would break before it is applied.

**See it live, read-only, at [vocabulary.majerus.us](https://vocabulary.majerus.us).**
Browse Concept Clusters' subject tree (`cc-subjects`) and an excerpt of the
Library of Congress Classification, explore the concept graph and sets, and
read the changelog. Editing controls are visible but greyed out; editing
needs the owner's sign-in.

It borrows its model from FHIR terminology servers: code systems become
**schemes**, value sets become **concept sets**, concept maps become
**maps**, and the operations (`lookup`, `expand`, `validate`, `subsumes`,
`translate`) keep their meaning. SKOS is the export format.

**Status: taxonomy editor, concept sets and graphs, SKOS interchange, read-only
MCP with sourced term proposals, a consumer changelog feed with progress
reports, and a public read-only view implemented.** SQLite stores the
vocabulary. The server runs on the LAN; its public hostname is read-only to
visitors, and editing, MCP and subscriber reports need Cloudflare Access.
Concept Clusters' subjects tree is imported as `cc-subjects`, and Concept
Clusters is the first consumer to follow its changelog. Usage reports, gates
and `propose_change` are still planned. What exists:

| | |
|---|---|
| [PLAN.md](PLAN.md) | The plan of record: how it came out of corpus-mcp's stages 1 and 2, the FHIR mapping, resources, surfaces, the editor, order of work, decisions, and open questions |
| [design/mockups/](design/mockups/) | Mockups of the editor's two pages, taxonomy and concept sets |
| [src/](src/) | TypeScript store, versioned reads, local HTTP API, MCP tools, Access checks, and demo fixture |
| [public/](public/) | Browser editor: taxonomy outline and term details, concept sets, and the concept-graph explorer |
| [docs/local-development.md](docs/local-development.md) | Storage design, API, verification, and current limits |
| [docs/oxigraph-feasibility.md](docs/oxigraph-feasibility.md) | Runnable Oxigraph experiment, measured results, and storage recommendation |
| [docs/skos.md](docs/skos.md) | File/SPARQL scheme import, SKOS field mappings, export, and local Oxigraph integration test |
| [docs/concept-sets.md](docs/concept-sets.md) | Explicit, ordered, nested and recipe sets; versioned expansion and SKOS collection interchange |
| [docs/concept-graphs.md](docs/concept-graphs.md) | Create and import concept networks; graph explorer, typed edges, quote-mcp compatibility and graph APIs |
| [docs/following-changes.md](docs/following-changes.md) | For consumers: reach the server, bootstrap a scheme, follow the changelog, report progress and holds, propose terms from a reference vocabulary, change kinds, slugs |
| [docs/deployment.md](docs/deployment.md) | Deploying to the Debian LXC host, status checks, Access settings, public read-only mode and rollback |
| [docs/mcp.md](docs/mcp.md) | Connect agents to the LAN MCP endpoint; term search/lookup, graphs, collections, validation, subsumption, SKOS and changelog tools |

## Run locally

Requires Node.js 22 or later and npm.

```sh
npm install
npm run demo
```

Open **http://127.0.0.1:8000**. The demo creates a separate, persistent
`data/demo.sqlite` with sample tree and polyhierarchical schemes. These are
demonstration terms, not an import from your other projects.

MCP clients can connect to **http://127.0.0.1:8000/mcp** using Streamable
HTTP. The same endpoint is available on the configured LAN hostname;
see [MCP access](docs/mcp.md) for client setup and the fourteen tools (all
read-only except `propose_term`). A public hostname can be opened read-only
to visitors while editing stays behind Cloudflare Access; see
[deployment](docs/deployment.md#public-read-only).

For an empty workspace for your own vocabulary, stop the demo and run:

```sh
npm start
```

This uses `data/terminology.sqlite`. Create a scheme, add terms, and edit
labels, alternative labels, scope notes, status, relations, and external
references. **+ Narrower term** can copy a new term from another vocabulary:
search it by label or code, and the new term takes its label and links to it,
recording where it came from. Each term gets a stable slug from its first label; **Change slug…**
alters it as a logged, breaking change. Saves survive restarts. Renames preserve old path aliases and
show a review dialog; the changelog records each applied change. The UI
also checks for conflicting edits from another tab.

Move, Merge, Split, and Retire have explicit impact previews and atomic commits.

To delete a concept scheme from the command line, run these commands on the
machine hosting its database, from the application directory. Use the server’s
existing Node.js runtime; npm and development dependencies are not needed to
run these commands. The normal application build produces `dist/cli.js`.

```sh
node dist/cli.js delete my-scheme
node dist/cli.js delete my-scheme --yes
```

The first command previews the deletion; `--yes` applies it atomically. This
removes the scheme, all its terms and concept sets from current reads, and
removes relations to its terms from other schemes. Historical versions and
source provenance remain available, and the deleted scheme ID stays reserved.
The deletion is recorded as a breaking `scheme-deleted` change. Use
`--db /path/to/terminology.sqlite` or `TERMINOLOGY_DB` to select a database;
the default is `data/terminology.sqlite` (use `--db data/demo.sqlite` for the demo).

To rename a scheme’s display name, preview and apply with:

```sh
node dist/cli.js rename my-scheme "New scheme name"
node dist/cli.js rename my-scheme "New scheme name" --yes
```

This supports the same `--db` option and preserves the scheme ID. In the editor,
open **Scheme settings** to edit the scheme name and description, including
clearing the description. Changes preserve historical versions and appear in
the changelog.

Use **Import SKOS…** to add a scheme from a Turtle file or SPARQL endpoint,
and **Export SKOS ↓** to download the current scheme. Imports preserve source
IRIs and all five SKOS mapping types; preview reports omitted data before saving.

Open **Concept sets** to group terms into named collections or define recipes
using descendants, related neighbourhoods, and exclusions. Preview membership
before saving; ordered and nested collections round-trip through SKOS with
their scheme. See [concept sets](docs/concept-sets.md) for structural-change
behavior and versioned expansion.
The term editor can assign a concept to multiple collections in the same save.
Imports default to **Auto**, with content-based structure recommendations,
validated overrides and a compatibility matrix before Apply.

Use **Concept graph** to explore and edit a network of broader, narrower,
related and opposite concepts. New schemes can use a flat graph structure;
**Import graph…** accepts quote-mcp exports and native graph JSON, with preview
and atomic apply. See [concept graphs](docs/concept-graphs.md).

Set `TERMINOLOGY_DB` to choose a database path, `PORT` to change the port,
or `HOST` to change the bind address. The server binds to `127.0.0.1` by default. No external services or credentials are needed.

For a Debian LXC host accessed through SSH, see [deployment](docs/deployment.md).
VS Code recommends the same Task Buttons and Status Probe extensions used by
corpus-mcp and quote-mcp: **Deploy Terminology** selects main, a PR number, or
the server's current source; the adjacent status shows the deployed revision
and whether it needs updating.

```sh
npm run typecheck
npm test
npm run build
```

For browser checks, install a test browser once with `npx playwright install
chromium`, then run `npm run test:ui`. Alternatively, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chrome executable.

An optional `npm run test:oxigraph` probe exercises a separate Oxigraph server
with isolated sample graphs, writes a local report, and cleans up afterward.
It does not change the app's SQLite backend. Graph operations and atomic
history passed on the tested server; concurrent direct writes failed the
single-winner requirement. See the [feasibility results](docs/oxigraph-feasibility.md)
before interpreting its exit code or enabling a different backend.
The separate `npm run test:oxigraph-import` test verifies the actual application
import/export against Oxigraph using disposable source graphs and a test database.

## What it does, and what's next

Done: holding the vocabularies, concept sets, the editor, SKOS export and
import, the MCP tools, the changelog consumers follow with their reported
progress and holds, term proposals copied from reference vocabularies, and a
public read-only view. Still to come: usage-based impact, gates and leases,
`propose_change`, roll-up, maps and `translate`, and a snapshot file for
consumers that can't reach the server at all.

- **Hold the vocabularies.** Schemes of terms with opaque ids, labels,
  alternative labels, scope notes, status, links to Wikidata or LCSH, and
  broader, narrower, and typed associative relations, including `related`
  across schemes. The top terms of `cc-subjects` are CC's domains.
- **Define concept sets.** A list, or a recipe worked out on each read
  (include around, narrower of, exclude), for themes, map views, and each
  consumer's profile of the depth it shows.
- **Publish changes.** Every change is numbered in one changelog that
  consumers follow from their own cursor. Subscribers report how far they
  have applied it and hold at a change they won't apply on their own; the
  editor shows each one's pending and breaking changes and marks the terms
  it hasn't caught up on. Planned: renames, moves, merges, splits, and
  retirements show their impact on each subscriber's usage first, and
  subscribers can answer a gate.
- **Take proposals with provenance.** Consumers and agents propose new
  terms, each copied from a term in a reference vocabulary such as the
  Library of Congress Classification and linked to it. A proposal is usable
  at once as a provisional term; the owner confirms, merges or retires it.
- **Serve consumers and agents.** A REST API, an MCP server, SKOS exports,
  and a public read-only view; a snapshot file for consumers off the network
  is planned.
- **Edit.** A web editor with the whole tree in view, and a separate page
  for concept sets.

## Mockups

The files in [design/mockups/](design/mockups/) are the source of a Claude
Design canvas, one `.dc.html` file per page. They need the canvas runtime to
render, so they don't open in a browser on their own. The terms and counts
in them are sample data.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md), as for corpus-mcp and quote-mcp.
