# Alerts

ROAI Purser tells you when something needs a person: an agent near or at its spending
limit, spending far more than usual, stopped, or with a key about to expire; a workflow
past its stop line; or a request waiting for a decision.

Alerts go to Slack, Discord or any webhook. Email comes next.

## What alerts

| Type                | When                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `agent.near_limit`  | An agent has spent 80% of its daily or monthly cap (the share is a setting)            |
| `agent.at_limit`    | An agent has spent its whole cap, so its calls are refused                             |
| `agent.spend_spike` | Today's spend is 3 times the agent's 7-day average and at least $5 (both are settings) |
| `agent.stopped`     | Someone stopped an agent                                                               |
| `key.expiring`      | An agent's key expires within 7 days (a setting)                                       |
| `key.expired`       | An agent's key expired and its calls are refused                                       |
| `workflow.stop`     | A workflow's last 30 days cross the stop line written down before any result           |
| `request.waiting`   | Someone asked for an agent, a service or more budget, and a person has to decide       |

Each fires once for what it reports:

- near and at the limit, once per cap and window, and again if a raise moves the cap
- a spike, once per agent per day
- a key, once per key
- a workflow, once each time it crosses the stop line after being clear of it

A new agent needs at least three days of spend in the past week before it can spike.
Requests the rules approve at once don't alert.

Keys about to expire and workflows past their stop line are checked when Purser starts
and every hour. Everything else alerts as it happens.

## Bursts become one message

Alerts gather for two seconds before they're sent. More than three of one type at once,
such as stopping a whole department, arrive as a single message that names up to ten
and counts the rest.

## Channels

Admins add channels under **Alerts** in the web UI, or through the admin API. Each
channel gets every type, or only the types you choose, and can be paused, tested or
removed. The same page sets when to alert and lists the newest alerts, with where each
one was delivered.

| Kind      | Gets                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `slack`   | A Slack incoming webhook message                                                      |
| `discord` | A Discord webhook message. Mentions are switched off, so no name can ping `@everyone` |
| `webhook` | The JSON below, signed                                                                |

**Channel URLs are secrets.** Slack and Discord webhook URLs carry their own token, so
Purser keeps them with the provider keys and never shows them again, only a hint. A
URL must be `https://`; plain `http://` is allowed only to this computer, for testing.
Redirects are not followed.

**Sending.** Each channel gets three tries, a few seconds apart. A receiver that answers
4xx (other than 429) isn't tried again. Each try waits at most 5 seconds. A failed
delivery is written to the audit log as `alert.failed`, and the channel shows its last
delivery. **Test** sends a sample message straight away.

### The webhook body

```json
{
  "id": "alr_...",
  "type": "agent.at_limit",
  "severity": "warning",
  "at": "2026-11-24T18:02:11.000Z",
  "title": "support-bot reached its daily limit",
  "text": "support-bot (owner Dana Ortiz) has spent $10.50 of its $10.00 daily limit. ...",
  "url": "https://purser.example.com/agents?agent=agt_...",
  "count": 1,
  "data": {
    "agent": { "id": "agt_...", "name": "support-bot", "owner": "Dana Ortiz" }
  }
}
```

`severity` is `info`, `warning` or `critical`. A summed-up burst has a `count` above 1
and `data.items`. No message ever carries a key.

### Checking the signature

A webhook channel gets a signing secret when it is added, shown once. Each request
carries:

- `x-purser-event`: the alert type
- `x-purser-timestamp`: Unix seconds
- `x-purser-signature`: `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<body>` with
  the secret

Compute the same HMAC over the raw body, compare in constant time, and reject old
timestamps.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, timestamp, rawBody, signature) {
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return (
    fresh &&
    expected.length === signature.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  );
}
```

Links in alerts use `PURSER_BASE_URL` ([docker.md](docker.md)).

## Admin API

Under `/admin`, with the admin token or an admin's session ([admin-api.md](admin-api.md)).

| Route                            | Does                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `GET /alerts`                    | Settings, channels, the alert types and the newest alerts with deliveries        |
| `PUT /alerts/settings`           | Changes `nearLimitPercent`, `spikeMultiple`, `spikeMinUsd`, `keyExpiringDays`    |
| `POST /alerts/channels`          | Adds `{ name, kind, url, events? }`. A webhook's signing secret is returned once |
| `PATCH /alerts/channels/:id`     | Changes `name`, `url`, `events` or `enabled`                                     |
| `DELETE /alerts/channels/:id`    | Removes a channel and its saved URL                                              |
| `POST /alerts/channels/:id/test` | Sends a test message now and returns how it went                                 |

Changes to channels and settings are written to the audit log as `alerts.changed`.
