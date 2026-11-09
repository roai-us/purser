# ROAI Purser server (phase 0 prototype)

The gateway, the admin API and the web UI in one process. It is a prototype: it shows
that an agent can be given its own key, capped and stopped by changing nothing but
its base URL, and that a fleet of thousands of agents can be run from one screen. It
is not ready for production.

## Try it

You need Node 24 or later. From the repository root:

```bash
pnpm install
pnpm build
```

Start Purser. It opens the web UI in your browser with a one-time sign-in link, and
prints the link too:

```bash
node apps/server/dist/cli.js serve
```

Add your provider keys in the web UI, where each one is tested as you add it, or set
them in the environment (`PURSER_OPENROUTER_API_KEY=sk-or-...` and so on). Either
way they stay in the server and agents never see them.

To try the UI with a large, made-up fleet first, fill a separate data directory:

```bash
PURSER_DATA_DIR=~/.purser-demo node apps/server/dist/cli.js demo-seed --agents 1500
PURSER_DATA_DIR=~/.purser-demo node apps/server/dist/cli.js serve
```

Register an agent. Every agent needs an owner. The key is shown once:

```bash
node apps/server/dist/cli.js agent add support-bot --owner "Dana Ortiz" --daily 5 --monthly 50
```

Point the agent at Purser and give it its Purser key instead of a provider key:

```bash
OPENAI_BASE_URL=http://127.0.0.1:4141/openai/v1  OPENAI_API_KEY=purser_...
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/anthropic  ANTHROPIC_API_KEY=purser_...
```

For OpenRouter, use the base URL `http://127.0.0.1:4141/openrouter/api/v1` with the
agent's Purser key. Any OpenAI-compatible client works. Every connector's base URL is
in [docs/connectors.md](../../docs/connectors.md) and on the UI's provider page.

Watch the spend and stop the agent:

```bash
node apps/server/dist/cli.js agent list
node apps/server/dist/cli.js kill support-bot
node apps/server/dist/cli.js resume support-bot
```

`roai kill` pauses the agent and cuts any request it has open, including a stream
halfway through. Run `node apps/server/dist/cli.js help` for every command.

## What the prototype does

- **One key per agent.** A key starts with `purser_` and is stored only as a SHA-256
  hash. Rotating a key makes the old one stop working at once, or after a grace
  period you choose, so the tool can be updated without downtime. Keys can expire,
  and a rotation policy sets each new key's expiry.
- **Built for fleets.** Agents carry an owner and a team. The admin API filters,
  sorts and pages thousands of agents in milliseconds, and stops, resumes or rotates
  up to 1,000 at once.
- **Connectors.** OpenAI, Anthropic, OpenRouter, xAI, Google Gemini, Mistral, Groq,
  DeepSeek and Azure OpenAI are built in. Others are a JSON file away
  ([docs/connectors.md](../../docs/connectors.md)). Each agent can be limited to
  some connectors.
- **Caps and allowlists.** Daily and monthly dollar caps (UTC), a model allowlist and
  an end date for each agent.
- **Kill switch.** Pausing an agent refuses its new requests and aborts the ones it
  has open. The kill reports how long it took and how many requests it cut.
- **Metering.** Every call is metered from the provider's own token counts, including
  cached input, prompt-cache writes and streamed responses. It is priced from a
  dated table in `src/prices.ts`. A model missing from the table is charged at the
  table's most expensive rate, so caps trip early rather than late. OpenRouter
  reports what each call cost, so Purser records that figure and uses the table only
  when it is missing.
- **A separate admin surface.** The admin API takes the admin token or a signed-in
  browser session, never an agent key, so an agent cannot read or change anything
  there, including its own limits. The full API is in
  [docs/admin-api.md](../../docs/admin-api.md).
- **Private local data.** Agents, usage, an audit log and provider keys set in the UI
  (`vault.json`) are kept in `~/.purser`, with files only you can read. The desktop
  app will keep provider keys in the operating system's keychain instead. The server
  listens on localhost unless told otherwise.

## Endpoints proxied

Only endpoints Purser can meter are proxied. Anything else is refused, so there is no
unmetered side door around the caps.

| Connector       | Endpoints                                                                      |
| --------------- | ------------------------------------------------------------------------------ |
| OpenAI          | `POST /chat/completions`, `POST /responses`, `POST /embeddings`, `GET /models` |
| Anthropic       | `POST /messages`, `POST /messages/count_tokens`, `GET /models`                 |
| OpenRouter      | `POST /chat/completions`, `POST /responses`, `GET /models` (the list only)     |
| xAI, Groq       | `POST /chat/completions`, `POST /responses`, `GET /models` (the list only)     |
| Gemini, Mistral | `POST /chat/completions`, `POST /embeddings`, `GET /models`                    |
| DeepSeek        | `POST /chat/completions`, `GET /models` (the list only)                        |
| Azure OpenAI    | `POST /chat/completions`, `POST /responses`, `POST /embeddings`, `GET /models` |

## Subscriptions

Claude and ChatGPT plans are paid by the month, not by the call, and they sign in
with your own account. Purser never sits in front of a subscription and never
touches its login. Instead, it reads the usage your own coding tools already write
on your machine:

- Claude Code, from `~/.claude/projects`
- Codex CLI, from `~/.codex/sessions`

It totals the tokens by day and model, and shows what the same usage would have cost
at API prices. Put that next to what your plan costs and you can see whether the plan
pays for itself.

```bash
node apps/server/dist/cli.js subscriptions --since 2026-11-01
```

The same report is at `GET /admin/subscriptions?since=2026-11-01`. It is read-only:
Purser cannot cap or stop subscription usage, and it does not read the chat apps or
websites. Models missing from the price table are priced at its highest rate and
flagged.

## Known limits

- **Caps are checked before each request.** The request that crosses a cap still
  completes. Several requests started at the same moment can each pass the check.
  Pre-request cost estimates come in phase 1.
- **Streamed OpenAI chat completions:** Purser adds
  `stream_options.include_usage` so they can be metered. The agent receives one extra
  final chunk with no choices; the official SDKs handle it. If a stream is killed
  before it ends, OpenAI has not yet reported its tokens, so that request is recorded
  with zero tokens.
- **A killed OpenRouter stream** is recorded at zero cost for the same reason:
  OpenRouter reports the charge only in the final chunk.
- **Providers that leave usage out** of a successful response are charged a
  deliberately high estimate from the bytes sent and received, marked as an estimate.
- **Policy refusals return 403,** not 429. Most SDKs retry a 429, and an agent that
  hit its cap should stop rather than retry in a loop.
- **Storage is in memory with plain files.** Postgres arrives in phase 1, behind the
  same interface.
- **Sessions live in memory.** Restarting Purser signs browsers out.
- **Not yet built:** rate limits, the MCP proxy, discovery and revocation connectors
  and the other four layers of stop.

## Configuration

| Variable                                | Default                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PURSER_<ID>_API_KEY`                   | none. A provider key by connector id: `PURSER_OPENROUTER_API_KEY`, `PURSER_AZURE_OPENAI_API_KEY`. A key set in the UI wins. |
| `PURSER_<ID>_UPSTREAM`                  | the connector's own address. For Azure OpenAI, your resource URL.                                                           |
| `PURSER_PORT`                           | `4141`                                                                                                                      |
| `PURSER_HOST`                           | `127.0.0.1`                                                                                                                 |
| `PURSER_ALLOW_REMOTE`                   | unset. Set `1` to bind beyond localhost; put it behind HTTPS                                                                |
| `PURSER_DATA_DIR`                       | `~/.purser`                                                                                                                 |
| `PURSER_ADMIN_TOKEN`                    | generated into the data directory                                                                                           |
| `PURSER_WEB_DIR`                        | `apps/web/dist` in this repository                                                                                          |
| `PURSER_CLAUDE_DIR`, `PURSER_CODEX_DIR` | `~/.claude`, `~/.codex`                                                                                                     |
| `PURSER_URL` (CLI only)                 | `http://127.0.0.1:4141`                                                                                                     |

## Tests

```bash
pnpm --filter @roai-us/purser test
```

The tests run against a mock of both providers, in `src/test/mock-upstream.ts`.
`src/sdk.test.ts` drives the official OpenAI and Anthropic SDKs through Purser over
real HTTP, including the OpenAI SDK pointed at the OpenRouter mount. Each client is told only the base URL and its agent key. A kill stops a
streaming client in under a second.
