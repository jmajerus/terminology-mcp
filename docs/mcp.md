# MCP access

The running editor also serves **`POST /mcp`** using the official MCP SDK's
stateless Streamable HTTP transport (JSON responses). It shares the editor's
store, versions, configured hosts and origin protection. There is no separate
database or service to initialize. Every tool but `propose_term` only reads.
`propose_term` adds a provisional term for the owner to review; no tool edits,
imports, fetches external sources, or confirms proposals.

Start with `npm run demo` for sample data or `npm start` for your workspace.
The local endpoint is `http://127.0.0.1:8000/mcp`; the LAN deployment is
`http://terminology-mcp.localdomain:8000/mcp`. The existing
`TERMINOLOGY_ORIGINS` setting must include any non-loopback hostname used by
clients (see [deployment](deployment.md)). Direct LAN access remains available
from private peers naming the service's LAN hostname/IP. Proxied and public-host
requests require a verified Cloudflare Access assertion, except signed-out
reads when the public hostname is in read-only mode.

## Access applications

The three sibling servers use the same runtime settings in `/etc/<service>/env`:

```dotenv
ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
```

Public hostnames need no setting: a request through Cloudflare is served under
the hostname it arrived on.

Cloudflare Managed OAuth authenticates MCP clients at the edge and forwards a
signed JWT in `Cf-Access-Jwt-Assertion`. The origin verifies its signature with
the team's JWKS, issuer, expiry and subject on `/mcp` and on all other private
routes, including editor assets and `/api` reads/writes. It does not check the
audience (which Access application issued the token): every application in the
team admits only the owner, so recreating or merging applications needs no
change here. An invalid assertion never falls back to LAN access. Public hostnames
or requests carrying Cloudflare headers cannot take the LAN bypass.

A request through Cloudflare without an assertion is a read-only visitor,
so the owner's Access application must cover the whole hostname, `/mcp`
included, unless a [read-only hostname](deployment.md#public-read-only) is
intended. `/mcp`, writes and subscriber routes are refused for visitors
either way. OAuth discovery must remain reachable by MCP clients. The
origin returns JSON errors rather than generating its own login page; use
Cloudflare Managed OAuth for client sign-in. Configuration alone does not test
the user's OAuth consent/callback flow.

For VS Code, use its [MCP configuration format](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
and add the following server entry to `.vscode/mcp.json` in a client
workspace (replace the URL with loopback for a local demo):

```json
{
  "servers": {
    "terminology": {
      "type": "http",
      "url": "http://terminology-mcp.localdomain:8000/mcp"
    }
  }
}
```

Other clients should select Streamable HTTP and the same URL. There is no
legacy SSE endpoint, persistent session or stdio process in this milestone.
GET and DELETE return 405; clients send initialization, notifications and
tool calls as POSTs. HTTP clients must accept both `application/json` and
`text/event-stream`, as required by the transport protocol. See the
[official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Tools

The read tools advertise read-only, non-destructive, idempotent annotations;
`propose_term` advertises a non-destructive write.
Successful results include JSON in both `content` and `structuredContent`.
Tool failures use `isError: true`; schema validation rejects unsupported
arguments. Unknown versions, schemes and sets produce explicit errors.

| Tool | Purpose |
|---|---|
| `list_schemes` | List scheme definitions with their declared structure. |
| `search_terms` | Browse/search labels, alternative labels, notation values, aliases and source IRIs. Filter by scheme (or `excludeScheme`), expanded set and/or status. Each hit carries its `iri`. |
| `get_term` | Resolve a stable ID or exact alias; return fields, replacements and connections in all four directions. |
| `get_graph` | Active nodes and typed edges within a scheme, set or neighbourhood. Supports `around`, `depth` (0–5) and `types`. |
| `list_sets` | List collection definitions, optionally within a scheme. |
| `get_set` | Get a collection definition by stable set ID. |
| `expand_set` | Expand explicit, ordered, nested or recipe membership; preserve ordered collection order and retirement warnings. |
| `get_term_collections` | Same-scheme collections with direct, inherited, calculated and included flags. Includes collections the term is outside. |
| `validate_term` | Check existence, retirement and optional expanded-set membership; return replacements for retired terms. Provisional terms count as valid. |
| `subsumes` | Compare two terms through transitive broader links, including every parent. Related/opposite and mappings do not imply subsumption. |
| `get_changes` | Read change summaries after `since`, optionally filtered by stable term ID or by `scheme`. Request full revision bodies with `includeSnapshots: true`. |
| `export_skos` | Export a scheme and its collections as Turtle, preserving notations, mappings and collection definitions. |
| `list_subscribers` | Each consumer's reported progress through the changelog, what is pending for its schemes (and how much of it is breaking), and any change it is held at. |
| `propose_term` | Add a provisional term under an existing broader term (ID, alias or slug), copied from a `source` term in a reference vocabulary and linked to it with `match`. Find the source with `search_terms` first. Where the scheme's `proposalSource` is `optional` (`human-work`), pass `label` and `evidence` instead; in a concept graph, `broader` is optional. See [proposals](following-changes.md#proposing-terms). |

Search uses case-insensitive NFKC-normalized substring matching, without
fuzzy matching or full-text syntax. It includes active and provisional terms
by default; `status: "all"` also includes retired terms. `get_term` and
`validate_term` resolve retired identities and their aliases. Labels are not
unique identifiers; use search to find a term's stable ID.

`subsumes` returns `equivalent` for the same ID, `subsumes` when `a` is an
ancestor of `b`, `subsumed-by` for the inverse, and `not-subsumed` otherwise.
Retired terms retain their historical identity and can be compared; validate
them separately when checking whether they can be assigned to new content.

## Consistent reads and limits

Every tool accepts `at`, a changelog number, and returns the selected
`version`. Omit `at` for the current workspace. Reuse the returned version
on subsequent requests, especially when paging, so an editor save between
calls cannot change the selection. Version 0 is a valid empty snapshot.

List, search, expansion and term-collection tools accept `offset` (default
0) and `limit` (default 50, maximum 200). Results use `items`, `total`,
`offset` and `nextOffset` (null when complete). `expand_set` also returns
the set definition and warnings. For example:

```json
{"query":"psychic prison","scheme":"human-work","limit":10}
```

Pass a returned ID to `get_term` with the returned version as `at`, or
to `get_graph` as `around` to explore its typed neighbourhood.

For changelog catch-up, call `get_changes` with your saved `since` cursor.
Keep its `version` as `at` and continue with `nextSince` until null. Once
complete, record `version` as your new cursor, including when a term filter
matched no changes. Save the returned `log` with it: a different `log` means
the store was rebuilt, so bootstrap again instead of resuming. Report how far you got with the REST progress endpoint; notifications and
usage intake remain planned. See
[following changes](following-changes.md) for applying what the log returns.

Change summaries contain the change number, kind, affected term/set IDs,
subject ID/label, breaking flag, author, reason and timestamp. This keeps
large atomic imports from flooding a normal catch-up response. Set
`includeSnapshots: true` for full before/after bodies, or use versioned
term/set reads for individual records after a change.

Graphs exceeding 200 nodes or 1,000 directed edges require a narrower
selection; nodes/edges are never silently truncated. Every tool result is
limited to 1 MiB of serialized JSON. Use smaller pages, a neighbourhood or
a narrower filter if a result exceeds it. For large SKOS downloads use
`GET /api/schemes/:id/skos?at=N`. MCP request bodies are limited to 128 KiB.

Mapping links are returned on term fields and in SKOS; translation between
consumer-specific maps and roll-up profiles remain future work. All writes
continue through the editor and its existing validation/preview controls.

## Verification

`node --import tsx --test test/mcp.test.ts` starts isolated HTTP servers and
uses the official SDK client to initialize, discover and call the tools.
It covers paging across concurrent edits, historical reads, multi-parent
and cross-scheme relationships, collection order/membership, retirement,
SKOS, output limits and HTTP host/origin protections. `test/subscribers.test.ts`
covers `propose_term` and `list_subscribers`. The suite also runs
with `npm test`.
