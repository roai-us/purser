# Roadmap

Phases ship in order. Dates come once the gateway prototype tells us how big the work
is.

## Phase 0: foundations (now)

- [x] Repository, license, contribution rules, CI
- [x] `@roai-us/roi-core`: the ROI math shared with the roai.us calculator
- [x] Gateway prototype ([apps/server](../apps/server)):
  - OpenAI-compatible and Anthropic Messages proxying, including streaming
  - per-agent keys, daily and monthly caps, a model allowlist, and kill
- [x] Proof against mock providers: the official OpenAI and Anthropic SDKs, configured
      only through their base URL, are metered, capped and stopped mid-stream in under
      a second
- [x] OpenRouter through the gateway, metered from the charge OpenRouter reports
- [x] Subscription usage: Claude Code and Codex CLI logs on this machine, priced at
      API rates (read-only, never touching the subscription login)
- [x] Connectors as manifests: nine built in (OpenAI, Anthropic, OpenRouter, xAI,
      Google Gemini, Mistral, Groq, DeepSeek, Azure OpenAI) and custom ones from a JSON
      file ([connectors.md](connectors.md))
- [x] Built for fleets: owners and teams, a filtered, sorted and paged agent list that
      stays fast at 10,000 agents, bulk stop, resume and rotate, and per-agent
      connector allowlists
- [x] Key rotation with a grace period, key expiry and rotation policies
- [x] Provider keys set and tested from the admin API, kept in a private vault file
- [x] Browser sign-in for the web UI: a one-time link, strict session cookies, CSRF
      checks ([admin-api.md](admin-api.md))
- [x] `roai demo-seed`: a made-up fleet of any size, to try the UI at scale
- [x] Web UI: home, agents with green, yellow and red lights, a status bar on every
      page, providers, activity, a call log with retention, and one-time limit raises
- [x] Self-service foundation: company sign-in (OpenID Connect), admins, managers and
      employees, departments with their own rules and budgets, requests and approvals,
      and turning off a leaver's access ([self-service.md](self-service.md))
- [x] Rotate all keys, for a security incident: everyone's at once or one department's,
      with owners collecting their own ([admin-api.md](admin-api.md))
- [x] Agent accounts with more than one service, each with its own limits, so one agent
      can use another AI service through Purser ([agent-access.md](agent-access.md))
- [x] An MCP server, so agents can see and use their own Purser services
- [x] Guided replacement of provider keys on the Security page: each new key is tested
      before it takes over, and old keys are tracked until they're deleted at the provider
- [ ] The same proof against the live provider APIs (done for OpenRouter)

**Next:** per-agent OpenRouter keys created through OpenRouter's key management API
(`POST /api/v1/keys` with `limit`, `limit_reset` and `expires_at`, and disabled on
kill). That is a second layer of stop that needs no base URL change.

## Phase 1: the first release (v0.1)

- Agent register with owners and end dates, and a discovery queue
- Per-agent keys, daily and monthly caps, rate limits, model allowlists, kill and
  pause-all
- Spend metering with a dated, editable price table
- Workflows, the outcomes API, cost per accepted unit and a one-page ROI report
- `roai scan` for local discovery
- Alerts by email and webhook
- Personal and team modes, shipped as a Docker image and `npx`

**Done when:** a freelancer and a five-person team can each install it in under 10
minutes and see spend by agent and cost per accepted unit.

## Phase 2: control (v0.2)

- Connectors for provider admin and usage APIs: discovery, reconciliation, and key
  revocation as a second layer of stop
- One-click provider key rotation, opt-in for each provider, to consider later: Purser
  creates the new key, tests it, switches over and removes the old one. It needs a
  stronger credential that can create keys, so that credential must be kept apart and
  replaced by hand if the server is what was exposed. OpenRouter, OpenAI, xAI and Azure
  OpenAI have APIs for this, and Google Cloud may. Anthropic can only disable old keys
  this way, so new ones are still made by a person. It should come before per-agent
  provider keys are widely used, since those multiply the keys to replace.
- MCP proxy with per-agent tool allowlists: other MCP servers reached through Purser, as
  distinct from Purser's own MCP server
- Human approval for higher-risk actions, held at the proxy
- Automatic pause triggers and guided kill drills
- Monthly agent metrics

## Phase 3: reach (v0.3)

- Identity provider connectors (Google Workspace, Microsoft Entra, Okta) for OAuth
  grant discovery and revocation
- Source control and cloud agent platform connectors
- Vendor evidence file and AI system classification
- Desktop app

## Phase 4: edge

- Optional browser extension for AI tool discovery
- Evaluation harness for decision workflows
- Model routing suggestions

## 1.0

- Third-party security review, with every finding closed
- Complete docs, a Helm chart and a tested upgrade path
