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

**Status: planning.** No code yet. What exists:

| | |
|---|---|
| [PLAN.md](PLAN.md) | The plan of record: how it came out of corpus-mcp's stages 1 and 2, the FHIR mapping, resources, surfaces, the editor, order of work, decisions, and open questions |
| [design/mockups/](design/mockups/) | Mockups of the editor's two pages, taxonomy and concept sets |

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
