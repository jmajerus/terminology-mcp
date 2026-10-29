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