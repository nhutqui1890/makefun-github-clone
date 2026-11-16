# GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nhutqui1890/makefun-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nhutqui1890/makefun-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one dependency-free Node 22 process,
built for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty on [make.fun](https://make.fun). It serves real git clients over smart HTTP
and exposes the core GitHub API surfaces — REST v3, GraphQL v4 and MCP — backed by
its own in-memory store. No UI, no outside service, no `git` binary: every object,
pack and ref is handled by code in this repository.

## What it serves

- **Git smart HTTP** — `git clone` / `git push` over `http(s)`:
  protocol v2 (`ls-refs`, `fetch` with `shallow`/`deepen`, `have` negotiation),
  protocol v0 advertisement and fetch, and `receive-pack` with per-ref
  report-status, fast-forward enforcement and delta-pack unpacking
  (OFS_DELTA and REF_DELTA, including thin packs).
- **REST v3** (`/api/v3`) — repositories (create/read/update/delete, paginated
  listing with `Link` headers), branches, commits, git refs, contents
  (create/update/delete with stale-sha `409`s), labels, issues (filter/sort/
  paginate), issue comments, and pull requests (create, list, files diff,
  squash/merge with three-way conflict detection).
- **GraphQL v4** (`/api/graphql`) — `viewer`, `repository` (fields, issues with
  cursor pagination, pull requests, `mergeable`), `node` by global id,
  introspection (`__type`), and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` and `addComment` mutations — plus
  operation batching.
- **MCP** (`/mcp`) — JSON-RPC 2.0 with `server/discover` and `initialize`, and
  six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

Every surface shares one store, so an object created through MCP shows up over
REST and GraphQL, and a commit pushed with git is visible through the contents
and commits APIs.

## Running it

Requires Node 22.18+ (type stripping, no build step) and no dependencies:

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL`, and polls until the env says the trial is done. For local
development, start the server directly:

```sh
MAKEFUN_SHOP_TOKEN=shpat_test node --experimental-strip-types -e "
import('./app.ts').then(({ createApp }) => {
  const server = createApp();
  server.listen(3000, () => console.log('listening on 3000'));
});
"
```

When `MAKEFUN_SHOP_TOKEN` is set, every surface except `GET /healthz` requires
`Authorization: Bearer <token>`; when it is unset, any non-empty Bearer token
is accepted. The viewer identity is the competition's fixed scenario identity.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Entry <-> env lifecycle (bind, register, poll, exit). |
| `app.ts` | HTTP server, body reading, auth, routing. |
| `git-core.ts` | Git object model, packfile read/write, pkt-line codec. |
| `store.ts` | In-memory forge state: repos, objects, refs, issues, PRs. |
| `git-http.ts` | Smart HTTP: advertisements, ls-refs, fetch, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser and executor. |
| `mcp.ts` | MCP JSON-RPC handlers and the six tools. |
| `context.ts` | Shared request context and response helpers. |

## License

MIT — see [LICENSE](LICENSE).
