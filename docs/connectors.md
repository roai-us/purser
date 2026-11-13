# Connectors

A connector tells ROAI Purser how to sit in front of one AI provider's API: where it
lives, how it takes its key, which endpoints are proxied and how its usage is
metered. Built-in connectors and your own use the same description, so adding a
provider is a small JSON file, not new gateway code.

## Built-in connectors

| Connector     | Agents use base URL                       | Upstream                                                   | Key sent as |
| ------------- | ----------------------------------------- | ---------------------------------------------------------- | ----------- |
| OpenAI        | `http://127.0.0.1:4141/openai/v1`         | `https://api.openai.com/v1`                                | Bearer      |
| Anthropic     | `http://127.0.0.1:4141/anthropic`         | `https://api.anthropic.com/v1`                             | `x-api-key` |
| OpenRouter    | `http://127.0.0.1:4141/openrouter/api/v1` | `https://openrouter.ai/api/v1`                             | Bearer      |
| xAI           | `http://127.0.0.1:4141/xai/v1`            | `https://api.x.ai/v1`                                      | Bearer      |
| Google Gemini | `http://127.0.0.1:4141/gemini/v1`         | `https://generativelanguage.googleapis.com/v1beta/openai`  | Bearer      |
| Mistral       | `http://127.0.0.1:4141/mistral/v1`        | `https://api.mistral.ai/v1`                                | Bearer      |
| Groq          | `http://127.0.0.1:4141/groq/v1`           | `https://api.groq.com/openai/v1`                           | Bearer      |
| DeepSeek      | `http://127.0.0.1:4141/deepseek/v1`       | `https://api.deepseek.com`                                 | Bearer      |
| Azure OpenAI  | `http://127.0.0.1:4141/azure-openai/v1`   | your resource, `https://<name>.openai.azure.com/openai/v1` | `api-key`   |

Each built-in connector links to the provider's own documentation in
`apps/server/src/connectors.ts`. They were checked on 2026-11-07.

Only the endpoints Purser can meter are proxied (chat completions, the Responses API,
embeddings, Anthropic messages, and the model list). Anything else is refused, so
there is no unmetered side door around the caps.

**Metering.** OpenRouter reports what each call cost, and Purser records that figure.
The others are priced from the dated price table in `apps/server/src/prices.ts`. A
model missing from the table is charged at the table's highest rate, so caps trip
early rather than late. If a provider reports no token counts for a successful call,
for example in a stream, Purser charges a deliberately high estimate from the bytes
sent and received (marked `priced: "estimate"`), so leaving usage out cannot slip past
a cap.

A call cut off before its usage arrives, because the agent hung up, someone stopped it or
the connection failed, is also charged an estimate, since the provider bills for what it
produced. Input comes from the request and output from the answer seen before the cut,
at about one token per 3 characters. Estimates run high on purpose. A model missing from
the price table is charged at the highest rate, so a cut-off call can be recorded above
its true cost, but a paid model is never recorded at nothing.

OpenRouter has hundreds of models, so its estimates use the prices in its own model list,
which Purser loads when an agent uses OpenRouter and refreshes hourly. A free model is
charged nothing. Until the list has loaded, or for a model it doesn't price, the table
applies.

## Adding your own connector

Put a JSON file in `<data directory>/connectors/`, for example
`~/.purser/connectors/acme.json`, and restart Purser:

```json
{
  "id": "acme",
  "name": "Acme AI",
  "kind": "openai-compatible",
  "upstream": "https://api.acme.example/v1"
}
```

Agents then use the base URL `http://127.0.0.1:4141/acme/v1`. Set its key in the web
UI, or with `PURSER_ACME_API_KEY`.

| Field               | Required | Meaning                                                                                                     |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                | yes      | 2 to 32 lower case letters, digits and dashes, starting with a letter. Also the first part of the mount.    |
| `name`              | yes      | What the UI shows.                                                                                          |
| `kind`              | yes      | `openai-compatible` or `anthropic`: the wire format.                                                        |
| `upstream`          | yes      | The provider's base URL, including its version path. Must use https unless it runs on this machine.         |
| `auth`              | no       | `bearer` (default for OpenAI-compatible), `x-api-key` (default for Anthropic) or `api-key`.                 |
| `endpoints`         | no       | Which to proxy: `chat.completions`, `responses`, `embeddings`, or `messages`, `count_tokens`.               |
| `models`            | no       | `list` (default) proxies `GET /models`; `list-and-get` also `GET /models/<id>`; `none` proxies neither.     |
| `costSource`        | no       | `table` (default), or `provider` if responses report the charge in `usage.cost`.                            |
| `injectStreamUsage` | no       | Ask for usage in streamed chat completions (`stream_options.include_usage`). Only if the provider takes it. |
| `stripVendorPrefix` | no       | Price `vendor/model` ids by the part after the slash.                                                       |
| `testPath`          | no       | The GET path used to check a key. Default `/models`. It must refuse a bad key, so don't use a public path.  |
| `keysUrl`           | no       | The https page where an admin makes a new key. The Security page links to it.                               |
| `testModel`         | no       | A small, cheap model for a first test request.                                                              |
| `docsUrl`           | no       | A link the UI shows next to the connector.                                                                  |
| `keyPlaceholder`    | no       | What a key looks like, for the key field.                                                                   |

A file that does not validate is skipped and reported when Purser starts; it is
never half-loaded. An id may not repeat a built-in connector or take a reserved path
(`admin`, `auth`, `login`, `health`, `assets`, `static`, `api`).

## Later: code plugins

JSON manifests cover providers that speak a known wire format. Two kinds of
connector need code, and come later:

- **Discovery and revocation connectors.** These talk to admin APIs rather than sit
  in the request path: provider usage and key management, identity providers, and
  seat-based tools such as GitHub Copilot and Microsoft 365 Copilot. They find agents
  and spend that never pass through the gateway, and revoke access as a second layer
  of stop. They run on a schedule, outside the request path, so a slow or failing
  connector can never delay or open up a gateway call.
- **Signed packages.** Code plugins will ship as signed packages with a declared list
  of what they may reach, installed deliberately by an admin. Purser will not load
  unsigned code into the process that holds provider keys.
