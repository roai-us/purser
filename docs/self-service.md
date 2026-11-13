# People, departments and self-service

ROAI Purser works two ways, and both stay supported:

- **Admin-issued.** An admin adds each agent and hands its key to whoever runs the
  tool. Nothing below is needed for this. It is what the beta requires.
- **Self-service.** Employees sign in with their company account, see only their own
  agents, and ask for new ones. Their department's managers approve anything above
  the department's limits. Admins see everything.

## Roles

| Role    | Sees                                         | Can                                                                                                |
| ------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Member  | Their own agents                             | Ask for agents, collect keys, rotate keys, stop and restart what they stopped, ask for more budget |
| Manager | Their own agents and their departments' ones | All of the above, plus decide their departments' requests and raise limits directly                |
| Admin   | Everything                                   | Everything in the admin pages, including people, departments, providers and settings               |

A manager can't decide their own request; another manager of the department or an
admin has to. The exception is a request an agent files for itself, which its owner may
decide if it is within the department's auto-approve limit. An agent that a manager or admin stopped stays stopped until a manager
or admin turns it back on.

## Company sign-in

Any OpenID Connect provider works: Microsoft Entra ID, Okta, Google Workspace and
others. Purser never sees passwords.

1. In the identity provider, register a web application with the redirect URI shown
   on Purser's Settings page: `<Purser address>/auth/sso/callback`.
2. In Purser, under Settings, Company sign-in, enter the issuer URL, the client ID,
   the client secret, the email domains allowed to sign in, and the emails to make
   admins on their first sign-in.

Issuer examples:

- Microsoft Entra ID: `https://login.microsoftonline.com/<tenant id>/v2.0`. Use your
  own tenant id. Shared issuers (`common`, `organizations`) are refused, because they
  would accept accounts from any tenant.
- Okta: `https://<your org>.okta.com`
- Google Workspace: `https://accounts.google.com`

Purser uses the authorization code flow with PKCE, checks the ID token's signature,
issuer, audience, expiry and nonce, and lets in only emails whose domain is on the
allowed list. A person is added as a member the first time they sign in. Every
sign-in, and every refused one, is in Activity.

Routes: `GET /auth/sso/start` sends the browser to the provider, and
`GET /auth/sso/callback` finishes. A refused sign-in redirects to `/?login=<code>`,
where the code is one of `domain_not_allowed`, `disabled`, `invalid_state`,
`email_unverified`, `no_email`, `idp_error`, `sso_off` and a few setup errors.

`GET /auth/options` answers `{ sso: { label } | null, demo }` for the sign-in page.

### Demo sign-in

`pnpm demo` starts Purser with `PURSER_DEMO_SIGNIN=1`, which adds a list of sample
people to the sign-in page, so you can see each role without an identity provider.
It has no password, so it only works when Purser listens on this computer, and must
never be used with real data. `POST /auth/demo` with `{ personId }` signs in.

## Self-service rules

Each department follows the organisation's defaults unless it has its own rules:

- `autoApproveDailyUsd`: an agent asked for with a daily limit up to this is ready at
  once, and the person sees its key. 0 means every agent needs a manager's OK.
- `maxDailyUsd`: nobody in the department may ask for more per agent per day.
- `allowedProviders`: the connectors people may pick. Absent means any configured one.

Departments can also have a monthly budget, shown against their spend. It is not
enforced yet.

Self-service agents rotate their key every 90 days with a 7-day overlap. An approved
agent is created with a key nobody has seen; its owner collects a fresh one from the
agent's page ("Get your key").

## Leavers

Turning a person's access off signs them out everywhere, cancels their waiting
requests, and either stops all their agents at once or hands them to someone else.
Turning access back on leaves their agents stopped until someone turns them on.

## The /me API

For everyone who signs in. Same sign-in and `x-purser-csrf` rules as `/admin`.

- `GET /me` answers `{ viewer, selfService, policy, providers, mcp, keysWaiting, pending: { mine, toDecide } }`.
  `policy` is the viewer's department rules; `providers` lists configured connectors
  with the base URLs to paste, never keys; `mcp` is `{ enabled, url }`; `keysWaiting`
  counts the viewer's agents with a new key to collect.
- `GET /me/agents?scope=mine|team&q=&light=&page=&pageSize=` lists the viewer's own
  agents, or with `scope=team` also those of departments they manage. Same shape as
  `GET /admin/agents`, and the facets only name what the viewer can see.
- `GET /me/status?scope=mine|team` is the status board for those agents.
- `POST /me/agents` with `{ name, purpose, providers?, dailyUsd, monthlyUsd?, reason? }`
  answers 201 `{ status: "ready", agent, key, request }` within the auto-approve
  limit, or 202 `{ status: "pending", request }` above it. Errors: 400 `over_max`,
  `provider_not_allowed`, `unknown_provider`; 403 `self_service_off`; 409 `name_taken`.
- `GET /me/agents/:ref`, `GET /me/agents/:ref/usage?days=`: an agent the viewer can
  see. Anything else is 404.
- `POST /me/agents/:ref/kill`, `/resume`, `/rotate-key` (`{ graceMinutes? }`).
  Resume is 403 `stopped_by_other` for an owner when someone else stopped it.
- `POST /me/agents/:ref/raise-limit` with `{ window, amountUsd, reason? }`: a manager
  of the agent's department gets `{ status: "raised", agent }`; an owner gets 202
  `{ status: "pending", request }`.
- `GET /me/requests`: the viewer's own requests, waiting ones first.
  `POST /me/requests/:id/cancel` cancels one that is still waiting.
- `GET /me/approvals?status=`: requests the viewer may decide.
  `POST /me/approvals/:id/approve` and `/deny`, with `{ note? }`.

Asking for another service on an agent is in [agent-access.md](agent-access.md).

A request is
`{ id, kind: "agent" | "raise" | "service", status: "pending" | "approved" | "denied" | "cancelled", by, byName, department?, reason?, createdAt, agent?, raise?, service?, askedByAgent?, ownerMayDecide?, decidedAt?, decidedBy?, note?, agentId? }`.
`askedByAgent` is set when the agent asked over MCP; `by` is then its owner, who may decide
it when `ownerMayDecide` is set.
Requests are in the audit log as `request.created`, `request.approved`,
`request.denied` and `request.cancelled`.

## Admin routes

- `GET /admin/people?q=&role=&department=&status=&page=&pageSize=` answers
  `{ items, total, page, pageSize }`; each person comes with `agents`, `running` and
  `spendMonth`.
- `POST /admin/people` with `{ email, name, role?, department?, manages? }`.
  409 `email_taken`.
- `PATCH /admin/people/:ref` with `{ name?, role?, department? (null clears), manages? }`.
  `:ref` is an id or an email.
- `POST /admin/people/:ref/disable` with `{ reassignTo? }` answers
  `{ person, stopped, reassigned, sessionsEnded }`. `POST /admin/people/:ref/enable`.
- `GET /admin/departments` answers `{ defaults, selfService, items }`; each
  department has its rules, budget, people, managers, waiting requests, agent counts
  by light, and spend today and this month.
- `PUT /admin/departments/:name` with `{ budgetMonthlyUsd?: number | null, selfService?: rules | null }`.
- `GET /admin/settings/org` answers `{ selfService, defaults, signIn, redirectUri }`.
  `signIn` never includes the client secret, only `hasSecret`.
- `PUT /admin/settings/self-service` with `{ selfService?, defaults? }`.
- `PUT /admin/settings/sign-in` with
  `{ issuer, clientId, clientSecret?, allowedDomains, adminEmails?, label? }`. Leave out
  `clientSecret` to keep the stored one; send `""` to remove it. The secret is kept in
  the vault. `DELETE /admin/settings/sign-in` turns company sign-in off.

People, departments, requests and these settings are kept in `<data dir>/org.json`,
readable only by the user Purser runs as.

## Not built yet

- Automatic provisioning and removal from the identity provider (SCIM), so leavers
  are turned off without an admin.
- Department budgets that stop spending, not just show it.
- Email or chat notifications when a request needs a decision.
- Roles from identity provider groups.
