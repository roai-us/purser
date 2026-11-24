# Agent accounts, services and MCP

Every agent in ROAI Purser has its own account: one key, a named owner, spending limits and
a list of the AI services it may use. That key reaches any of those services through
Purser, so an agent never holds a provider's key.

This also works for an agent you already run somewhere else. A coding agent running on
one model can have a second one as a service, to get an adversarial review of its own
work. It keeps its one Purser key, and it can't spend more on the second model than its
account says.

Services use your company's account with each provider, through the keys an admin saved
under Providers. Purser never relays a personal subscription login, such as a ChatGPT or
Claude plan. For a model from OpenAI, that means the OpenAI API with a company API key.

## Services

An agent's `providers` list says which connectors it may use. If it has none, it may use
any connected one. On top of that, each service can have its own limits:

```json
{
  "providers": ["anthropic", "openai"],
  "limits": { "dailyUsd": 5 },
  "serviceLimits": {
    "openai": { "dailyUsd": 2, "monthlyUsd": 20, "models": ["gpt-4o"] }
  }
}
```

- The agent's overall limits still apply. A service limit only narrows them.
- A service's `models` list is used on that service instead of the agent's own, so an agent
  limited to one vendor's models can still have another vendor's as a service.
- A model is allowed if it equals an entry or starts with the entry and a dash, so
  `gpt-4o` also allows `gpt-4o-mini`.
- At a service's limit, calls to that service get 403 `budget_exceeded`. The agent's light
  stays green, because its other services still work.

### Who can change them

| Who             | What happens                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Admin           | Sets it directly, and may leave a service with no daily limit.                                                          |
| Manager         | Sets it directly on their departments' agents, with a daily limit.                                                      |
| Owner           | Within the department's auto-approve limit it applies at once. Above it, a manager decides.                             |
| The agent (MCP) | Files a request. Its owner may decide if it is within that limit; a manager decides if not. It never applies by itself. |

The department's maximum and its allowed providers apply to everyone but managers and
admins. An owner can take a service off a list, which only narrows what the agent can do,
but can't lift a limit on an agent allowed any provider. The last service on a list can't
be removed, because an empty list means any provider. Stop the agent instead.

### Routes

- `PUT /admin/agents/:ref/services/:provider` with `{ dailyUsd?, monthlyUsd?, models? }`.
- `DELETE /admin/agents/:ref/services/:provider`. 409 `last_service`.
- `POST /me/agents/:ref/services` with `{ provider, dailyUsd, monthlyUsd?, models?, reason? }`
  answers `{ status: "granted", agent, request? }` or 202 `{ status: "pending", request }`.
  Errors: 400 `over_max`, `provider_not_allowed`, `unknown_provider`; 403 `self_service_off`.
- `DELETE /me/agents/:ref/services/:provider`. 409 `last_service`; 403 `manager_only`.

Public agents also carry `serviceSpend: { [provider]: { today, month } }`. Non-streaming
gateway responses carry the header `x-purser-cost-usd`.

## The MCP server

Purser is an [MCP](https://modelcontextprotocol.io) server at `<Purser address>/mcp`. An
agent connects with its own key and sees only itself.

Most tools take the address and a header:

```json
{
  "mcpServers": {
    "purser": {
      "type": "http",
      "url": "http://127.0.0.1:4141/mcp",
      "headers": { "Authorization": "Bearer <the agent's key>" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add --transport http purser http://127.0.0.1:4141/mcp --header "Authorization: Bearer <the agent's key>"
```

Tools that only start local programs can use the `roai mcp` bridge, which passes messages
between stdin and the server:

```json
{
  "mcpServers": {
    "purser": {
      "command": "roai",
      "args": ["mcp"],
      "env": {
        "PURSER_URL": "http://127.0.0.1:4141",
        "PURSER_AGENT_KEY": "<the agent's key>"
      }
    }
  }
}
```

### Tools

| Tool                  | What it does                                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| `get_my_account`      | Owner, department, state, limits, spend and key expiry                                |
| `list_my_services`    | The services it may use, with allowed models, limits and spend                        |
| `list_models`         | The models a service offers that it may use                                           |
| `ask_model`           | Puts one question to a model on one of its services and returns the answer            |
| `get_my_usage`        | Recent spending, in total and by service and model                                    |
| `request_service`     | Asks for another service. A person decides.                                           |
| `request_more_budget` | Asks for a one-time raise. A person decides.                                          |
| `check_my_requests`   | What happened to its requests                                                         |
| `report_outcome`      | Records a result for its workflow: accepted, reworked or discarded ([roi.md](roi.md)) |

### What it can't do

- See any other agent, or any key.
- Change its own limits or services. It can only ask.
- Get around anything. `ask_model` goes through the gateway as if the agent had called the
  provider itself, so caps, allowlists, the kill switch, metering and the call log all apply.
- Flood anyone. One waiting request per service, and five waiting at a time.
- Ask for anything while it is stopped. Its read-only tools still answer, so it can tell why.

Requests an agent files are marked as coming from it, wherever people see them. What it
writes as a reason is its own words: read it as you would any other input from that agent.

Stopping the agent, rotating its key or letting the key expire applies here too. During a
rotation's overlap the old key still connects, and `get_my_account` warns that it is the
old one.

An admin can turn the server off under Settings, or with `PUT /admin/settings/mcp`
`{ "enabled": false }`.

### Protocol

Streamable HTTP, stateless and JSON only: `POST /mcp` with one JSON-RPC message, the key as
`Authorization: Bearer` or `x-api-key`. Protocol versions `2025-11-25`, `2025-06-18` and
`2025-03-26`. Other sites are refused by their `Origin` header. Messages are limited to 2 MB.
`GET` and `DELETE` answer 405, since there are no sessions and no event stream.

## In the demo

`pnpm demo` saves a stand-in key for every connector. Calls made with that key are answered
on this computer, with a reply that says it is a demo, so everything above works with no
provider account and no charges. Replies are metered as if they were real, so limits and
spend behave normally. A real key pasted in under Providers goes to the real provider.

The first employee on the sign-in page owns `code-review-partner`, a coding agent with OpenAI
as a second service. Rotate its key to get a working one, and connect a real MCP client to it.
