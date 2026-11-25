# Admin API

The ROAI Purser web UI and the `roai` CLI both use this API. Everything is JSON. Admin routes
live under `/admin`. The gateway mounts that agents call are described in
[connectors.md](connectors.md).

## Signing in

- `roai serve` creates a one-time sign-in code (32 random bytes, base64url, valid for
  15 minutes, single use). It prints
  `Open Purser: http://127.0.0.1:4141/login?code=<code>` and opens that link in the
  default browser, unless started with `--no-open`.
- `GET /login?code=` spends the code and starts a session: it sets the cookie
  `purser_session` (random, HttpOnly, SameSite=Strict, Path=/, Max-Age 12 hours,
  Secure when the request came over https) and redirects to `/`. A bad, used or stale
  code redirects to `/?login=failed`.
- `POST /auth/session` with `{ "token": "<admin token>" }` also starts a session, for
  the sign-in screen. A wrong token gets 401 `invalid_token`. After 10 attempts in a
  minute, across the whole server, it answers 429 `rate_limited`.
- `DELETE /auth/session` signs out. `GET /auth/session` answers
  `{ authenticated, viewer?: { kind: "owner" | "person", role, name, email?, department?, manages? } }`
  and never 401. The owner is whoever signed in with the link or the admin token.
- Everyone else signs in with their company account. See
  [self-service.md](self-service.md) for company sign-in, roles and the `/me` API.
- Every `/admin/*` route accepts either `Authorization: Bearer <admin token>` or the
  session cookie of the owner or of a person with the admin role. Managers and members
  get 403 `forbidden`. If an `Authorization` header is sent, it must hold the admin token,
  even when a cookie is present.
- With cookie sign-in, every request other than GET must carry the header
  `x-purser-csrf: 1`, or it gets 403 `csrf_required`.
- Agent keys are never accepted on `/admin/*` or `/auth/*`.
- Sessions live in memory: restarting Purser signs everyone out.

## Security incidents

- `GET /admin/security?department=` answers
  `{ confirm, peopleCanSignIn, agents: { total, ownerCollects, adminGets, waiting }, departments, providers, history }`.
  `waiting` counts the whole fleet; the others follow `department`. Never includes a key.
- `POST /admin/security/rotate-all` with
  `{ confirm: "ROTATE ALL KEYS", reason, department?, graceMinutes? }` replaces every agent's
  key, or every key in one department, including stopped agents, which stay stopped.
  It answers `{ rotated, waitingForOwners, keys: [{ id, name, owner, team?, key }], abortedRequests, oldKeysUntil?, elapsedMs }`.
  - With `graceMinutes` 0, the default, old keys stop at once and their running requests are
    cut. With an overlap the old keys keep working until it ends, and nothing is cut.
  - An agent whose owner is an active person gets a key nobody has seen and `awaitingKey`
    set, as long as people can sign in here. The owner collects a fresh one from the agent's
    page. Everyone else's new key is in `keys`, the only time it can be read.
  - 400 `confirm_required` without the phrase. The reason is kept in the audit log as
    `keys.rotated_all`, with a `agent.key_rotated` event per agent.
- `GET /admin/agents?awaitingKey=1` lists the agents still waiting for their owners.

Purser can't replace the keys it holds for your providers: make new ones at each provider
and save them under Providers. To replace the admin token, delete `admin-token` from the
data folder and restart, or change `PURSER_ADMIN_TOKEN`.

## Errors

`{ "error": { "code": string, "message": string, "issues"?: [...] } }` with a fitting
status. `issues` lists validation problems on a 400 `invalid_request`.

## Agents

An agent as the API returns it:

```
{ id, name, owner, team?, purpose?,
  providers?: string[]        // connector ids it may use; absent means any configured one
  status: "active" | "paused",
  state: "running" | "paused" | "at_limit" | "expired" | "key_expired",   // derived
  keyHint, keyRotatedAt?, previousKeyValidUntil?,
  keyExpiresAt?,              // when the current key stops working; absent means never
  rotation?: { everyDays, graceDays },
  keyState: "ok" | "expiring" | "expired",   // expiring: within 14 days of keyExpiresAt
  limits: { dailyUsd?, monthlyUsd?, models?: string[] },
  raised: { dailyUsd?, monthlyUsd? },   // one-time raises in force now, on top of limits
  logCalls?,                  // keep its call bodies when logging is set to chosen agents
  spend: { today, month },    // US dollars, UTC day and month
  requests: { today },
  lastUsedAt?, createdAt, endsAt?, pausedAt?, pausedBy? }
```

`state` says whether the agent can make calls right now. Only `running` can; the
others give the reason it can't, checked in this order: `paused` (someone stopped
it), `expired` (past its `endsAt`), `key_expired` (its current key lapsed),
`at_limit` (it hit a daily or monthly cap). The web UI shows a light for each:
green for `running`, yellow for `at_limit` (a one-time raise clears it), and red for
the rest.

Key hashes are never returned. `previousKeyValidUntil` appears only while an old key
is still in its grace period.

Names use letters, numbers, single spaces, dots, dashes and underscores, up to 80
characters, and are unique. Anywhere `:ref` appears, an agent id or its name works.

- `GET /admin/agents?q=&in=&state=&keyState=&provider=&owner=&team=&sort=&dir=&page=1&pageSize=50`
  answers `{ items, total, page, pageSize, facets: { owners, teams, providers } }`.
  - `sort` is one of `name` (the default, ascending), `spend_today`, `spend_month`,
    `created`, `last_used` or `key_expires` (keys that never expire come last). Other
    sorts default to descending.
  - `pageSize` is at most 200.
  - `q` is split into words, and every word must appear in one of the searched
    fields, ignoring case: `finance openrouter` finds Finance agents on OpenRouter.
    By default (`in=all`) the fields are the name, id, purpose, owner, team and
    provider. `in=name`, `in=owner`, `in=team` or `in=provider` searches just that
    one. Providers match by connector id or display name, whether the agent is
    allowed that connector or has used it.
  - `state` takes any agent state, or `not_running` for every state but `running`.
  - `light` takes `green`, `yellow` or `red`, the colours above.
  - `provider` matches agents allowed that connector or that have used it.
  - Facets cover every agent, not just the filtered ones.
- `POST /admin/agents` with
  `{ name, owner, team?, purpose?, providers?, limits?, endsAt?, keyExpiresAt?, rotation? }`
  answers 201 `{ agent, key }`. The key is shown once. A taken name is 409
  `name_taken`; an unknown connector is 400 `unknown_provider`. With `rotation` and no
  `keyExpiresAt`, the first key expires `rotation.everyDays` from now.
- `GET /admin/agents/:ref` answers the agent.
- `PATCH /admin/agents/:ref` with
  `{ owner?, team?, purpose?, providers?, limits?, endsAt?, keyExpiresAt?, rotation? }`
  answers the agent. `null` clears `team`, `purpose`, `providers`, `endsAt`,
  `keyExpiresAt` and `rotation`. `limits` replaces the whole set, so a limit left out is removed.
  `PATCH /admin/agents/:ref/limits` merges with the limits already set and answers `{ agent }`.
- `POST /admin/agents/:ref/kill` answers `{ agent, abortedRequests, elapsedMs }`. It
  refuses new requests, cuts open ones and revokes any old key in its grace period.
- `POST /admin/agents/:ref/resume` answers `{ agent }`.
- `POST /admin/agents/:ref/rotate-key` with `{ graceMinutes?: 0..10080, keyExpiresAt? }`
  answers `{ agent, key, previousKeyValidUntil? }`. See "Key rotation and expiry".
- `POST /admin/agents/bulk` with
  `{ action: "kill" | "resume" | "rotate-key", ids: string[] (1 to 1000), graceMinutes?, keyExpiresAt? }`
  answers `{ results: [{ id, name?, ok, error?, key? }], abortedRequests?, elapsedMs }`.
  Rotated keys are shown once, in `results`. Unknown ids come back with `ok: false`.
- `POST /admin/kill-all` answers `{ paused, abortedRequests, elapsedMs }`.
- `GET /admin/agents/:ref/usage?days=30` answers
  `{ daily: [{ date, costUsd, requests, inputTokens, outputTokens }], recent }`. `daily`
  has one row per UTC day, oldest first, today last, zero-filled. `recent` holds the
  newest 50 usage records, newest first.

## One-time limit raise

`POST /admin/agents/:ref/raise-limit` with
`{ window: "day" | "month", amountUsd: 0.01..1000000, reason? }` answers `{ agent }`.
The agent may spend that much more in the current UTC day or month only; when the
window ends, the normal limit applies again. Raises add up within a window. An
agent with no limit for that window is 400 `no_limit`. Each raise is in the audit
log as `agent.limit_raised`, with who gave it and why.

## Key rotation and expiry

- **Grace period.** A rotation with `graceMinutes` keeps the old key working until
  then, so the tool using it can be updated without downtime. Usage records say which
  key made each call (`key: "current" | "previous"`). A kill, or another rotation,
  revokes the old key at once.
- **Rotation policy.** `rotation: { everyDays: 1..730, graceDays: 0..30 }`. When an
  agent has one, each rotation sets the new key's `keyExpiresAt` to now plus
  `everyDays`, and, if `graceMinutes` is left out, keeps the old key for `graceDays`.
  The request may override `keyExpiresAt`. Without a policy, a new key never expires
  unless the request says so.
- **An old key never outlives its own expiry.** The grace period ends at the old
  key's `keyExpiresAt` if that comes first, and a key that has already expired gets
  no grace at all.
- **Expired keys.** A request with an expired current key gets 403 `key_expired`:
  "This agent's key expired on <date>. Ask its owner to rotate it." Purser writes one
  `key.expired` audit event per key. The agent is not paused; rotating issues a key
  that works.
- **No silent rotation.** Purser cannot put a new key into a tool, so an expiry never
  rotates a key by itself. Delivering keys to secrets managers is a later connector.
- `keyExpiresAt` must be in the future wherever it is set.

## Overview

`GET /admin/overview` answers:

```
{ spend: { today, month }, requests: { today },
  agents: { total, running, paused, atLimit, expired, keyExpired },
  providers: { configured, total },
  keys: { expiring, expired },
  topToday: Agent[] (up to 5),
  recentEvents: AuditEvent[] (10, newest first) }
```

## Status board

`GET /admin/status?limit=100` answers the fleet at a glance, cheap enough to poll:

```
{ total, running, notRunning, atLimit,
  stopped: [{ id, name, owner, team?, state, since?, by? }] }
```

`stopped` lists the agents that can't run, most recently stopped first, up to
`limit` (at most 1000); `notRunning` always has the full count, and `atLimit` says
how many of those are yellow. `since` is when it
was paused, when it ended, when its key lapsed, or its last call for an agent at its
limit. `by` is who paused it. The web UI draws one yellow or red light per entry at
the top of every page.

## Call log

Purser always records each call's cost, tokens, model and result. The call log also
keeps what was said: the request body the agent sent and the response it got back.
It is off until an admin turns it on. Keys are never logged; they travel in headers,
which are not kept.

- `GET /admin/settings` answers `{ logging: { mode, retentionDays, maxKb } }`.
- `PUT /admin/settings/logging` with any of
  `{ mode: "off" | "all" | "selected", retentionDays: 1..365, maxKb: 1..1024 }`
  saves and answers the same shape. `selected` keeps only agents with
  `logCalls: true`. Shortening `retentionDays` deletes older calls at once. Each
  change is in the audit log as `settings.changed`.
- `GET /admin/logs?agent=&before=&limit=50` answers
  `{ items: CallSummary[], next?, settings }`, newest first, at most 200 a page.
  A summary has `id` (the usage record's id), `agentId`, `agentName`, `at`,
  `provider`, `endpoint`, `model`, `status`, `outcome`, `costUsd`, `durationMs`,
  `requestPreview`, `responsePreview` and `truncated`. Pass `next` back as `before`.
- `GET /admin/logs/:id` answers the summary plus `request`, `response` and
  `responseText` (the answer's text, pieced together for a stream). Every read is in
  the audit log as `log.viewed`, with who read it.

Calls are kept in `<data dir>/logs/<UTC day>.jsonl`, readable only by the user
Purser runs as. Each request and response is cut to `maxKb`. Whole days older than
`retentionDays` are deleted at startup, every hour, and when the setting changes.
Usage records of logged calls carry `logged: true`.

## Providers (connectors)

```
Connector { id, name, kind: "openai-compatible" | "anthropic", source: "builtin" | "custom",
  agentBaseUrl,               // the full URL agents paste, e.g. http://127.0.0.1:4141/openrouter/api/v1
  envHint: { baseUrlVar, apiKeyVar },
  configured, keyHint?, keySource?: "vault" | "env",
  lastTest?: { ok, at, latencyMs?, error? },
  testModel?, docsUrl?, keyPlaceholder?,
  needsUpstream?, upstream?, costSource: "provider" | "table" }
```

- `GET /admin/providers` answers `Connector[]`.
- `PUT /admin/providers/:id/key` with `{ apiKey, upstream? }` answers the connector.
  `upstream` is only for connectors with `needsUpstream` (Azure OpenAI), must use https
  unless it is on this machine, and is kept when only the key changes.
  - A first key is stored, then tested. One that fails is kept, with the failure in
    `lastTest`.
  - A replacement is tested first, because every agent on that provider runs on the
    current key. If the test fails it answers 422 `key_test_failed` and nothing changes.
    If it passes, the next call uses it, and the old key's hint joins `oldKeys`, unless
    the provider had rejected that key.
  - Errors: 400 `upstream_required`, `upstream_not_allowed`, `invalid_upstream`,
    `same_key`; 422 `key_test_failed`. The audit log records `provider.key_set`,
    `provider.key_rotated` or `provider.key_rejected`, with hints and never a key.
- `POST /admin/providers/:id/old-keys/deleted` clears `oldKeys` and answers the
  connector. It records an admin's word that they deleted those keys at the provider, as
  `provider.old_keys_deleted`. Purser can't check this.
- `POST /admin/providers/:id/test` answers `{ ok, latencyMs?, error? }`. It asks the
  provider about the stored key, so it never runs a model.
- A connector in `GET /admin/providers` also has `keysUrl?` (where its keys are made),
  `keySetAt?` (when the key was saved, absent for a key from the environment) and
  `oldKeys?: [{ hint, replacedAt }]` (replaced keys still to delete).
- `DELETE /admin/providers/:id/key` removes the vault key and answers the connector. A
  key from the environment, if any, applies again.
- Keys are never returned or logged; `keyHint` shows only the first and last four
  characters.

## Activity

- `GET /admin/audit?limit=100&before=&agent=` answers `{ items, next? }`, newest
  first, at most 500 a page. Pass `next` back as `before` for the next page; `before`
  also accepts an ISO 8601 time.
- `GET /admin/usage?agent=&limit=100` answers `{ usage }`, newest first, at most 1000.
- `GET /admin/subscriptions?since=` reports what coding tools logged on this machine,
  priced at API rates. Purser cannot cap or stop subscription usage.

## Workflows and ROI

Workflows, their results and the ROI report are under `/admin/workflows`. See
[roi.md](roi.md).

## Alerts

Alert channels, thresholds and history are under `/admin/alerts`. See
[alerts.md](alerts.md).

## Web UI

Any other GET that is not under `/admin`, `/auth`, `/login`, `/health` or a gateway
mount serves the web build, with a fallback to `index.html` for app routes. UI
responses carry a strict content security policy (`default-src 'self'`, no inline
script, no framing), `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`.
