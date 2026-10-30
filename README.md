# terminology-mcp

The master taxonomy server: one home for the subject terms and concepts that
[concept-clusters](https://github.com/jmajerus/concept-clusters) (CC),
[corpus-mcp](https://github.com/jmajerus/corpus-mcp), and
[quote-mcp](https://github.com/jmajerus/quote-mcp) tag things with today,
each in its own copy. Consumers key on stable term ids, follow a numbered
changelog, and see what a change would break before it is applied.

It borrows its model from FHIR terminology servers: code systems become
**schemes**, value sets become **concept sets**, concept maps become
**maps**, and the operations (`lookup`, `expand`, `validate`, `subsumes`,
`translate`) keep their meaning. SKOS is the export format.

**Status: local taxonomy editor and SKOS interchange implemented.** SQLite
stores the vocabulary; consumer integrations are still planned. What exists:

| | |
|---|---|
| [PLAN.md](PLAN.md) | The plan of record: how it came out of corpus-mcp's stages 1 and 2, the FHIR mapping, resources, surfaces, the editor, order of work, decisions, and open questions |
| [design/mockups/](design/mockups/) | Mockups of the editor's two pages, taxonomy and concept sets |
| [src/](src/) | TypeScript store, versioned reads, local HTTP API, and demo fixture |
| [public/](public/) | Browser editor: outline, term details, and changelog |
| [docs/local-development.md](docs/local-development.md) | Storage design, API, verification, and current limits |
| [docs/oxigraph-feasibility.md](docs/oxigraph-feasibility.md) | Runnable Oxigraph experiment, measured results, and storage recommendation |
| [docs/skos.md](docs/skos.md) | File/SPARQL scheme import, SKOS field mappings, export, and local Oxigraph integration test |

## Run locally

Requires Node.js 22 or later and npm.

```sh
npm install
npm run demo
```

Open **http://127.0.0.1:3210**. The demo creates a separate, persistent
`data/demo.sqlite` with sample tree and polyhierarchical schemes. These are
demonstration terms, not an import from your other projects.

For an empty workspace for your own vocabulary, stop the demo and run:

```sh
npm start
```

This uses `data/terminology.sqlite`. Create a scheme, add terms, and edit
labels, alternative labels, scope notes, status, relations, and external
references. Saves survive restarts. Renames preserve old path aliases and
show a review dialog; the changelog records each applied change. The UI
also checks for conflicting edits from another tab.

Move, Merge, Split, and Retire have explicit impact previews and atomic commits.
Use **Import SKOS…** to add a scheme from a Turtle file or SPARQL endpoint,
and **Export SKOS ↓** to download the current scheme. Imports preserve source
IRIs and all five SKOS mapping types; preview reports omitted data before saving.

Set `TERMINOLOGY_DB` to choose a database path or `PORT` to change the port.
The server binds to `127.0.0.1`. No external services or credentials are needed.

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

## What it will do

- **Hold the vocabularies.** Schemes of terms with opaque ids, labels,
  alternative labels, scope notes, status, links to Wikidata or LCSH, and
  broader, narrower, and typed associative relations, including `related`
  across schemes. The top terms of `subjects` are CC's domains.
- **Define concept sets.** A list, or a recipe worked out on each read
  (include around, narrower of, exclude), for themes, map views, and each
  consumer's profile of the depth it shows.
- **Publish changes.** Additions go out at once. Renames, moves, merges,
  splits, and retirements show their impact on each subscriber first, and
  subscribers can hold delivery or answer a gate.
- **Serve consumers and agents.** A REST API, an MCP server, SKOS exports,
  and a snapshot for consumers off the LAN.
- **Edit.** A web editor with the whole tree in view, and a separate page
  for concept sets.

## Mockups

The files in [design/mockups/](design/mockups/) are the source of a Claude
Design canvas, one `.dc.html` file per page. They need the canvas runtime to
render, so they don't open in a browser on their own. The terms and counts
in them are sample data.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE.md), as for corpus-mcp and quote-mcp.
