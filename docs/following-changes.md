# Following changes

How a consumer such as Concept Clusters keeps a local copy of a scheme
current. It reads a snapshot once, then follows the numbered changelog.
The consumer keeps its own cursor and reports its progress back, so the editor
shows how far each one has got. Usage reports, gates and leases are planned
(see [PLAN.md](../PLAN.md)); everything below works today.

## Reaching the server

| From | Reads (`GET`) | Progress reports, proposals, MCP |
| --- | --- | --- |
| The LAN, naming the LAN host (`http://terminology-mcp.localdomain:8000`) | Open | Open; the caller names itself |
| The visitors' hostname (`vocabulary.majerus.us`) | Open | Refused with 401 |
| The owner's hostname (`terminology-mcp.majerus.us`), through Cloudflare Access | Allowed | Allowed; the verified email or subject names the caller |

A consumer off the LAN can therefore follow the changelog without
credentials, through the visitors' hostname. To report progress or propose terms, it
needs an Access identity that names a user. Cloudflare Access service tokens
aren't accepted yet: their assertions carry no subject, which the server
requires. Until that changes, report from the LAN. Signed-out reads see email addresses, such as change authors and
proposers, as "an editor"; nothing else in the data differs. See
[deployment](deployment.md#public-read-only) for the setup.

## A subscriber's loop

1. **Bootstrap** once: read the state, store the terms, save `log` and
   `version` as the cursor, and report `through` = `version`.
2. **Each tick**, read the changes since the cursor for your schemes.
   - If `log` changed, the store was rebuilt: bootstrap again and report with
     `reset: true`.
   - Otherwise apply the changes in order, stopping at the first one you
     won't apply on your own.
3. **Report**: `through` is the last change you applied, plus `blocked` if
   you stopped at one. Report when the cursor or the hold changes, and as a
   heartbeat every few minutes.
4. **Resume** after the owner deals with the hold, for example by reverting
   the change or coordinating it with you. The next report without
   `blocked` clears the hold.

The sections below cover each step.

## Bootstrap

```
GET /api/state?scheme=cc-subjects
```

The response holds `log`, `version`, `head`, the scheme, its terms (with
derived `path`, `depth` and `narrower`, and always a `status`) and its concept
sets. Store the terms keyed by `id`, and save `log` and `version` together as
the cursor, then report `through` = `version`. An
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
correct; the kind says why it changed. An `added` term copied from another
vocabulary carries `source: {id, scheme, uri, label, match}` and the matching
link; a proposed one also carries `proposal`. A consumer that doesn't use
them can ignore both.

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
| `scheme-changed` | A scheme’s name, description or settings changed | no |
| `scheme-deleted` | A scheme and its terms and sets left current state; incoming relations were removed. `beforeTerms` includes removed and updated terms; `afterTerms` contains surviving updated terms only. Historical reads remain available. | yes |
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

## Reporting progress

```
POST /api/subscribers/concept-clusters/progress
{"log": "…", "through": 512, "label": "Concept Clusters", "schemes": ["cc-subjects"]}
```

The first report registers the subscriber; its id is lowercase letters,
digits and hyphens. `through` is the last change fully applied. `schemes` and
`label` are kept from the last report that sent them, and `pending` counts
only changes in those schemes. A report doesn't advance the changelog.

When the subscriber stops at a change it won't apply on its own, it says so:

```
{"log": "…", "through": 512, "blocked": {"at": 513, "code": "slug-change", "reason": "Slug in 40 player URLs"}}
```

`code` is free text for grouping (Concept Clusters sends `slug-change`,
`subcategory-move`, `depth-change`, `split` or `retire-ambiguous`). A later
report without `blocked` clears it.

### What the owner sees

- The editor's **Subscribers** panel, beside the changelog, lists each
  subscriber with:
  - how far it has got (`through #N`);
  - how many changes in its schemes are still pending, and how many of
    those are breaking;
  - when it last reported;
  - any hold, with its code and reason; **Held at #N** opens that change.
- The outline marks each term with a change that some subscriber hasn't
  applied yet. The **pending** mark's tooltip names those subscribers.
- The panel shows only subscribers that have reported.

Visitors on the read-only hostname don't see the panel, because
`/api/subscribers` needs an Access identity.

Refusals:
- a `log` that isn't the store's is 409, with the current `log`;
- `through` beyond the head is 400;
- `through` below the last report is 409, unless the body has `reset: true`
  (after the subscriber wiped its own cursor and bootstrapped again);
- `blocked.at` must be after `through` and no later than the head.

Report when a tick advances the cursor or changes the hold, plus a heartbeat
every few minutes so `lastSeen` means the subscriber is alive.
`GET /api/subscribers` (or the MCP `list_subscribers` tool) returns every
subscriber with `through`, `head`, `pending`, `pendingBreaking`,
`pendingTerms`, `blocked` and `lastSeen`.

## Proposing terms

Every proposed term is copied from a term in a reference vocabulary, so it
carries its provenance. Find the source first, for example with the MCP
`search_terms` tool (`scheme: "loc-classification"`, or
`excludeScheme: "cc-subjects"`), which returns each hit's `iri` and
notations. If nothing fits even broadly, leave the addition to a person in
the editor, where a source is optional.

```
POST /api/proposals
{"scheme": "cc-subjects", "broader": "geography", "source": "GB2401-2598", "match": "closeMatch",
 "label": "Glaciology", "proposer": "concept-clusters:authoring", "evidence": {"draftId": "d-17"}, "requestId": "d-17"}
```

A proposal is created at once as a `provisional` term, so it can be used
straight away. The answer (201) carries `id`, `slug`, `status`, `change` (its
change number) and the full `term`.

- `broader` is a stable ID, an alias or a slug in the target scheme. In a
  concept graph it may be left out, making the proposal a top concept.
- `source` names one term in another scheme by stable ID, alias, IRI or
  notation, tried in that order. `sourceScheme` narrows it to one scheme
  when a notation repeats.
- `match` says how the new term relates to the source: `closeMatch` (the
  default), `broadMatch` (the source is wider, common with the LCC
  excerpt), `narrowMatch`, `exactMatch` or `relatedMatch`.
- `label` defaults to the source's label; override it when the wording
  should differ. The slug is minted from the label, or taken from `slug`.

The new term links to the source's IRI (its source IRI, else an http(s)
alias, else `urn:terminology-mcp:term:<id>`) with that match. The change is
an ordinary `added`, with `author` set to the proposer and a `proposal`
field holding the proposer, evidence and
`source: {id, scheme, uri, label, match}`, so a subscriber applies it like any
other addition. The term itself keeps the same record as `source`. A term a
person copies from another vocabulary in the editor gets one too.

- **Retries:** the same proposer and `requestId` return the original term
  (200, `replayed: true`) instead of a duplicate.
- **Duplicates:** a sibling with the same label, or a term whose slug or
  former slug clashes in the new term's slug scopes (siblings, the
  scheme-wide depths in `slugUniqueDepths`, or the whole scheme when its
  `slugScope` is `scheme`), is a 409 with `reason`
  (`duplicate`, or `retired` for a retired match) and
  `existing: {id, slug, label, status, replacedBy}`. Use the existing term,
  or propose a different `slug`.
- **Already linked:** a sibling with a `closeMatch` or `exactMatch` to the
  same source refuses a new close or exact match, and an `exactMatch` is
  unique across the scheme. Both are a 409 with `reason: "linked"` and
  `existing`; a retired claim still counts, and `existing` shows its status
  and `replacedBy`. Broad, narrow and related matches to one source are
  allowed.
- **Evidence instead of a source:** a scheme whose `proposalSource` is
  `optional`, such as quote-mcp's `human-work`, also takes a proposal with
  no `source`, when it carries `label` and `evidence`:

  ```
  POST /api/proposals
  {"scheme": "human-work", "label": "Flexibility", "proposer": "quote-mcp", "requestId": "tag:flexiblity",
   "evidence": {"quote": 412, "tag": "flexiblity", "text": "…"}}
  ```

  The term then has no `source` and no link; its `proposal` holds the
  evidence, for the owner to weigh before confirming.
- **Source:** otherwise, no `source` is 422, with a hint to search first. A source that
  isn't found is 404; several matches are a 409 with `reason: "ambiguous"`
  and `candidates`; a source in the target scheme, or a retired one, is 422.
- **Depth:** a proposal deeper than the scheme's maximum depth is 422.
  `cc-subjects` allows depth 2, so subcategories can't have narrower terms.
- **Who:** on the LAN the caller names the `proposer`. Through Cloudflare
  Access the verified email names it instead.

The MCP `propose_term` tool takes the same fields. The owner reviews open
proposals in the editor's **Open proposals** list: **Confirm** makes the
term active (an `updated` change), and **Merge into…** or **Retire…** handle
the rest.

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
