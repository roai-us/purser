# Architecture

This is the design ROAI Purser is being built toward. Parts of it do not exist yet;
the [roadmap](roadmap.md) says what ships when.

## The one idea

You can only stop and measure what passes through a point you control. Purser's
first point of control is the **credential path**:

- Each agent calls AI providers with a key that Purser issued.
- Purser holds the real provider keys.
- Purser can refuse an agent's key at any moment.

## Components

| Component                               | What it does                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control plane**                       | The agent register, the ledger, workflows and ROI, policy, alerts, the web UI and the admin API                                                                                                                      |
| **Gateway**                             | An LLM proxy (OpenAI-compatible and Anthropic Messages APIs first) and, later, an MCP proxy. It checks each agent key, enforces caps, rate limits and allowlists, meters tokens and cost, and refuses stopped agents |
| **Connectors**                          | Read-only at first: provider admin and usage APIs, then identity providers and SaaS. They find agents and keys we did not issue, reconcile spend, and later revoke keys and OAuth grants as a second layer of stop   |
| **`roai` CLI**                          | Starts a local server, registers agents, pauses them (`roai kill <agent>`) and runs `roai scan`                                                                                                                      |
| **Desktop app** (later)                 | A menu-bar wrapper around a local server, for people who will never open a terminal                                                                                                                                  |
| **Browser extension** (later, optional) | Privacy-first discovery of AI tool use in the browser. It records domains, minutes and account type, never prompt text                                                                                               |

The control plane and the gateway run in **one process** by default. Larger setups
can run the gateway separately, near the agents.

## Where it runs

| Mode       | Runs on                                 | Storage                    | Sign-in                                               |
| ---------- | --------------------------------------- | -------------------------- | ----------------------------------------------------- |
| Personal   | Your laptop, bound to `127.0.0.1`       | Embedded Postgres (PGlite) | None                                                  |
| Team       | One container or small VM, behind HTTPS | Postgres                   | Email and passkeys, or OIDC (Google, Microsoft, Okta) |
| Enterprise | Your cloud or Kubernetes                | Postgres, optional Redis   | OIDC; SAML and SCIM later                             |

## Layers of stop

Stopping an agent means cutting every path it can act through. Purser tracks five
layers for each agent and shows which ones are wired up:

1. **Identity.** Disable the agent's service account or identity (connectors).
2. **Tokens.** Revoke its provider keys and OAuth grants everywhere (connectors).
3. **Gateway.** Refuse its Purser key. This takes seconds and is the first layer to
   ship.
4. **Runtime or network.** Stop the process or block its egress. Purser can notify or
   call your runbook, but it does not own your runtime.
5. **Expiry.** Short-lived keys end on their own. The longest-lived credential in the
   chain sets the worst case.

A kill drill times each layer. An agent whose stop has never been tested is shown as
untested.

## Keys and secrets

- Agent keys are shown once and stored only as hashes.
- Provider keys are encrypted at rest with envelope encryption. The master key comes
  from an environment variable, a key management service or the OS keychain.
- Agent keys have no access to the admin API. It runs on a separate path with separate
  credentials, and an agent can never raise its own limits.
- Every admin action goes to an append-only, hash-chained audit log, so tampering
  shows.

## Data Purser keeps

| Kept by default                                      | Kept only if you turn it on, per agent                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Agent, model, tokens, cost, latency, status, outcome | Prompts, responses and tool-call content, each with its own retention period |

## Stack

| Layer              | Choice                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Language           | TypeScript throughout                                                    |
| Server             | Node 24, Hono, Zod, OpenAPI generated from the schemas                   |
| Database           | Postgres via Drizzle; PGlite in personal mode                            |
| Web UI             | React and Vite, served by the server as static files                     |
| CLI                | `roai`, published to npm                                                 |
| Desktop (later)    | Tauri 2 with the server as a sidecar                                     |
| Extension (later)  | WXT, Manifest V3                                                         |
| Telemetry standard | OpenTelemetry GenAI semantic conventions for outcome ingest and export   |
| Tests              | Vitest and Playwright; 100% coverage on ROI math, keys and the kill path |
