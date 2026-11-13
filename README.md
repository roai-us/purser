# ROAI Purser

**A free, self-hosted control panel for AI agents and AI spend.**

ROAI Purser gives every AI agent its own key, a named owner, a spending cap and a
kill switch. It also ties every AI dollar to the work that dollar paid for. It runs on
your laptop, on one small server, or in your own cloud. Your keys and your data never
leave your machines.

> **Status: early development.** Nothing here is ready to run in production yet. We
> are in phase 0. The shared ROI math is done. A [gateway prototype](apps/server)
> already gives each agent its own key, caps its spend and stops it mid-stream, for
> OpenAI, Anthropic and OpenRouter. It can also show what your Claude Code and Codex
> subscription usage would have cost at API prices. Watch
> the repo or read the [roadmap](docs/roadmap.md) to follow along.

## Why "Purser"

On a ship, the purser keeps the money, the list of everyone aboard and the keys to the
safe. ROAI Purser does the same for your AI:

- **The money:** a ledger of every AI dollar, tied to the return it produced.
- **The list:** a register of every agent, each with a named owner and an end date.
- **The keys:** a key for each agent, with limits you set and a switch that stops it.

## What it will do

**Agent register.** Each agent gets one record. The record holds its owner, its
purpose, the model it runs on, what it can reach, its limits, how to stop it and when
it ends. An agent with no owner can't be registered. Agents that turn up in discovery
but are not registered yet go into a queue, so you can see your "shadow rate": the
share of agents found that weren't already in the register.

**Keys, limits and the kill switch.**

- Each agent gets its own key, issued by Purser.
- The real provider keys stay in Purser's vault, where the agent can't read them.
- Spending caps are enforced on the server, never in the interface. They can be set per
  day and per month, with a separate cap for the most expensive models.
- Rate limits, model allowlists and destination allowlists are enforced the same way.
- One click pauses an agent, a team or everything.
- Automatic triggers pause an agent:
  - when its spend runs far above its normal rate
  - when it calls an unexpected destination
  - when it tries to change its own limits
- Kill drills time each layer of the stop, so you know how fast "stop" really is.

**The ledger.**

- Spend is metered for every call that goes through Purser.
- That spend is checked against provider billing, so spend nobody owns stands out.
- Subscriptions, implementation costs and evaluation costs can be added by hand.
- Spend can be viewed by agent, team, workflow and model.

**Return.**

- **Workflows are the unit.** Each one records a baseline taken before rollout, an
  attribution method and the thresholds that would scale it or stop it. The thresholds
  are locked before the first result comes in.
- **Outcomes.** Outcomes come in through an API or OpenTelemetry, or are tallied by
  hand. They record work as accepted, reworked or discarded.
- **Results.** Purser reports cost per accepted unit, net return, payback and which
  input moves the result most.
- **Every number is labelled measured, attributed or modelled.**
- **Adoption is shown separately,** because activity is not return.

**Discovery.** `roai scan` checks a machine for:

- MCP server configs
- AI command-line tools
- AI keys in `.env` files (it reports a fingerprint only, never the key)
- local ML tools on known ports
- browser extensions that can read every site

## How it works

```
  your agents, scripts and tools
          │  base URL + their own Purser key
          ▼
  ┌─────────────────────────────────────────┐
  │ ROAI Purser                             │
  │  gateway: keys, caps, kill, metering    │──▶ AI providers
  │  control plane: register, ledger, ROI   │    (your keys, held here)
  └─────────────────────────────────────────┘
          ▲
  connectors: provider admin APIs, identity providers (discovery and revocation)
```

**Most agents switch over with one setting.** Point the agent's base URL at Purser.
Most SDKs and coding agents read `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`. From then on,
every call is metered, capped and stoppable.

**Some agents can't be put behind a gateway.** For those, connectors to provider and
identity admin APIs find them and revoke their access.

**Every agent shows its stop coverage:** which layers of stop are wired up and when each
was last tested. The full design is in [docs/architecture.md](docs/architecture.md).

## Principles

1. **Runs on your machines.** Self-hosted by default. It sends no telemetry.
2. **Every formula is open.** No black-box scores. The math is in
   [`packages/roi-core`](packages/roi-core).
3. **Safety is never paywalled.** The register, keys, caps, kill switch and ROI stay
   free.
4. **No prompt content by default.** Purser logs tokens, cost, model and outcome. Content
   logging is opt-in per agent, with its own retention period.
5. **A stop that has never been tested is not counted as a control.**
6. **Activity is not return.** Seats and active users never stand in for ROI.

## Who it's for

- **Individuals:** freelancers, creators and solo builders who want a cap and a
  pause on every key, and an honest answer to "is this AI subscription worth it?"
- **Small teams and businesses:** an agent register with owners, per-agent keys and
  caps, and ROI by workflow.
- **Enterprises:** connectors, approval tiers, kill drills and evidence for auditors.
  These come in later phases.

## The method behind it

Purser puts into practice what ROAI publishes at [roai.us](https://roai.us), including:

- [Who Let That Agent In?](https://roai.us/research/who-let-that-agent-in) (identity,
  limits and a kill switch for every AI agent): the agent
  register, limits, approval tiers and the layers of stop.
- [Measuring AI ROI: A Practical Framework](https://roai.us/research/measuring-ai-roi-a-practical-framework):
  baselines, attribution and full cost.
- [The seven controls an AI pilot needs on day one](https://roai.us/insights/seven-controls-an-ai-pilot-needs):
  the day-one checklist.

## Repository layout

| Path                | What it is                                                      |
| ------------------- | --------------------------------------------------------------- |
| `packages/roi-core` | The ROI math shared with the roai.us calculator. 100% coverage. |
| `apps/server`       | Gateway, admin API and `roai` CLI (phase 0 prototype)           |
| `apps/web` (coming) | Web UI                                                          |
| `docs/`             | Architecture and roadmap                                        |

## Development

You need Node 24 or later and pnpm 10.

```bash
pnpm install
pnpm check
```

`pnpm check` runs the type check, lint, format check and tests with coverage.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md). Contributors
sign a short [Contributor License Agreement](CLA.md). If you find a security issue, follow
[SECURITY.md](SECURITY.md); please don't open a public issue.

## License

ROAI Purser is free to use and its source is public, under the
[Elastic License 2.0](LICENSE). You need a commercial license only to offer it to others as
a hosted or managed service; see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). `packages/roi-core` is under the
[Apache License 2.0](packages/roi-core/LICENSE). See [LICENSING.md](LICENSING.md) and
[NOTICE](NOTICE).
