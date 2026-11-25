# Per-agent OpenRouter keys

Normally every agent's OpenRouter calls go out on one shared OpenRouter key, the one
saved under Providers. Purser enforces each agent's caps and stops it, so OpenRouter
never needs to know which agent is which.

With per-agent keys turned on, ROAI Purser gives each agent that uses OpenRouter its own
OpenRouter key, made through OpenRouter's
[key management API](https://openrouter.ai/docs/features/provisioning-api-keys). The
agent still calls Purser with its Purser key and never sees the OpenRouter one. What
changes is what OpenRouter itself enforces:

- **A cap at OpenRouter.** Each key gets the agent's spending limit, so OpenRouter
  refuses the agent at its cap even if something got past Purser.
- **A second layer of stop.** Stopping the agent in Purser also disables its key at
  OpenRouter. Resuming it enables the key again.
- **An end date at OpenRouter.** A key expires when its agent ends.
- **Spend you can check.** Purser reads what OpenRouter says each key spent, next to
  what Purser metered.

Nothing changes for the agent: no new base URL, no new key to hand out.

## Setting it up

1. At OpenRouter, make a **management key** under Settings, Management keys. A
   management key can make and change keys but can't call any model. A key scoped to
   one workspace is safer than one for the whole organization.
2. Save it in Purser (`PUT /admin/openrouter/management-key`). Purser checks it with
   OpenRouter first and refuses an ordinary API key. It is kept in the vault, apart from
   the shared OpenRouter key, and never shown again.
3. Turn per-agent keys on (`PUT /admin/openrouter/agent-keys` with `{ "enabled": true }`).
   OpenRouter itself must be connected too.

Agents that list OpenRouter among their services, or have already used it, get keys
straight away. An agent allowed any service gets one after its first OpenRouter call;
that first call goes out on the shared key.

## What each key is set to

| OpenRouter field | From the agent                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `Purser: <agent name>`                                                                                                                                           |
| `limit`          | Its daily cap if it has one, else its monthly cap, else none. Whichever is lower of the agent's own cap (with any raise in force) and its OpenRouter service cap |
| `limit_reset`    | `daily` or `monthly`, to match                                                                                                                                   |
| `disabled`       | True while the agent is stopped                                                                                                                                  |
| `expires_at`     | The agent's end date, if it has one                                                                                                                              |

OpenRouter takes one limit per key, so an agent with both a daily and a monthly cap gets
the daily one there. Purser still enforces both. Both count days and months in UTC.

Keys follow the agent: a new limit, a raise, a stop or a resume is sent to OpenRouter as
it happens. OpenRouter can't change a key's expiry, so a new end date gets a new key and
the old one is deleted. When an agent ends, or OpenRouter is taken off its services, its
key is deleted.

Every hour, and when Purser starts, it reads each key back from OpenRouter: what it
spent today and this month, and whether it is still there.

## When something goes wrong

- **A key someone deleted at OpenRouter, or disabled there.** Purser marks it broken
  and refuses that agent's OpenRouter calls with 503 `agent_key_unavailable`. It never
  quietly switches the agent back to the shared key, since that would get round a stop
  made at OpenRouter. Replace the key to carry on
  (`POST /admin/agents/:ref/openrouter-key`).
- **OpenRouter unreachable or failing.** The change is shown on the key and tried again
  a minute later, and at every hourly check. A key that couldn't be made yet leaves the
  agent on the shared key until it can.
- **Rate limits.** OpenRouter allows 10,000 key changes a day. Purser sends at most four
  at once and waits and retries when told to slow down.

Every key made, disabled, enabled, deleted or failed is in the audit log as
`openrouter.key`, never with the key. Changes to the setting and the management key are
`openrouter.changed`.

## Turning it off

`PUT /admin/openrouter/agent-keys` with `{ "enabled": false }` deletes every key Purser
made at OpenRouter, and agents go back to the shared key at once. The management key can
be removed only after that.

## What to know about the management key

A management key can make new OpenRouter keys that spend your credits. Purser keeps it
in the vault next to the provider keys, so anyone who can read Purser's data folder can
read it. If that folder is exposed, delete the management key at OpenRouter as well as
the shared key.

## Admin API

| Route                               | Does                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `GET /openrouter/agent-keys`        | `{ managementKey: { set, hint }, enabled, connected, keys, problems }`     |
| `PUT /openrouter/management-key`    | Saves `{ key }` after checking it. 400 `invalid_key`                       |
| `DELETE /openrouter/management-key` | Forgets it. 409 while per-agent keys are on                                |
| `PUT /openrouter/agent-keys`        | `{ enabled }`. 409 without a management key or a connected OpenRouter      |
| `GET /agents/:ref/openrouter-key`   | `{ enabled, key, failure }`: the key's limit, state, spend and any problem |
| `POST /agents/:ref/openrouter-key`  | Replaces the agent's key with a new one                                    |
