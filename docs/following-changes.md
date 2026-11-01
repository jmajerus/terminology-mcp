# Following changes

How a consumer such as Concept Clusters keeps a local copy of a scheme
current. It reads a snapshot once, then follows the numbered changelog.
Nothing has to be registered on the server: the consumer keeps its own
cursor. Subscriber registration, usage reports and gates are planned (see
[PLAN.md](../PLAN.md)); everything below works today.

## Bootstrap

```
GET /api/state?scheme=cc-subjects
```

The response holds `log`, `version`, `head`, the scheme, its terms (with
derived `path`, `depth` and `narrower`) and its concept sets. Store the terms
keyed by `id`, and save `log` and `version` together as the cursor. An
unknown scheme answers 404.

## Catch up

```
GET /api/changes?since=<version>&scheme=cc-subjects
```

The response holds `log`, `version` (the head) and `changes`: every change
after `since` that touches the scheme, in order. Apply each one, then save
the returned `version` as the new cursor, even when `changes` is empty. A
`since` beyond the head answers 400.

If `log` differs from the saved one, the store was rebuilt. The change
numbers no longer refer to the same history, so discard the cursor and
bootstrap again.

The MCP `get_changes` tool reads the same log in pages, with the same
`scheme` filter and `log` id; see [MCP access](mcp.md).

## Applying a change

Each change carries `n`, `kind`, `terms` (the affected term ids), `before`
and `after` (the primary record), `breaking`, `author`, `reason` and `at`.
Changes to existing terms, and imports, also carry `beforeTerms` and
`afterTerms`: full snapshots of every term the change touched, such as the descendants of a moved or
renamed term and the children reparented by a merge. Set changes carry
`beforeSets` and `afterSets`. Replacing each local term with its
`afterTerms` snapshot (or `after` for an `added` term) is enough to stay
correct; the kind says why it changed.

| Kind | Meaning | Breaking |
| --- | --- | --- |
| `scheme-added` | A scheme was created | no |
| `imported` | A scheme was imported, with all its terms | no |
| `added` | A term was created | no |
| `noted` | Only the scope note changed | no |
| `labelled` | The preferred label changed | yes |
| `updated` | Other fields, relations or explicit set membership changed | when a relation was removed or the term left a set |
| `moved` | Broader terms changed; descendants' paths follow | yes |
| `merged` | The source retired into a target, which took its children and relations | yes |
| `split` | The source retired into two or more new terms | yes |
| `retired` | The term retired, optionally with replacements | yes |
| `slugged` | The slug changed; the old one moved to `formerSlugs` | yes |
| `set-added` | A concept set was created | no |
| `set-changed` | A set's definition changed | when its label, order or recipe changed, or a member was removed |
| `set-deleted` | A set was deleted | yes |

`breaking` means the change may break some consumer, not that every
consumer must stop. A consumer keyed on term ids only sees a rename as a new
label, while a consumer keyed on labels or slugs needs to act on `labelled`
or `slugged`. Decide per kind.

Retired terms stay in the log and in reads, with `status: "retired"` and
`replacedBy`. Re-point local references to the replacements rather than
deleting them.

## Slugs and aliases

Every term has a server-minted `slug`, which never changes on a rename. Only
an explicit `slugged` change alters it, and the old value stays in
`formerSlugs`. A consumer whose URLs or ids use slugs can resolve old links
with:

```
GET /api/schemes/cc-subjects/slugs/<slug>?parent=<ref>&depth=<d>
```

`parent` (an id, alias or slug) or `depth` narrows a slug that repeats
across branches. Aliases such as `cc-domain:…` and tree paths resolve through
`GET /api/terms/<url-encoded alias>`. Path aliases only ever accumulate, so
an old path still finds its term after a move or rename.

## Pinning reads

Every read takes `at=N`, so a consumer can read state as it was at its
cursor while new changes arrive. Historical reads return the requested
`version` and the current `head`.
