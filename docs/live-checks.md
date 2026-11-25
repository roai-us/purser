# Live provider checks

The tests prove ROAI Purser against mock providers on every pull request. The live check
runs the same proof against the real ones, with your keys, when you ask for it.

For each built-in provider with a key set, it starts Purser on this machine and points
that provider's official SDK at it. Like a real agent, the SDK is given only Purser's
address and an agent key. Then it checks five things:

| Check              | Passes when                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Answers            | A call gets an answer                                                                            |
| Metered            | The call is recorded from the provider's own token counts, not an estimate, and the counts match |
| Streams, metered   | A streamed call is answered and recorded at a cost above zero                                    |
| Refused at cap     | An agent at its cap gets 403, and nothing reaches the provider                                   |
| Stopped mid-stream | Stopping the agent cuts a running stream within a second, and the cut-off call is still charged  |

The report also says when a model is missing from Purser's price table, so its cost was a
guess at the table's highest rate.

## Running it

Set a key for each provider to check, in the same variables Purser itself reads, then run
it from a checkout:

```bash
export PURSER_OPENAI_API_KEY=...
export PURSER_ANTHROPIC_API_KEY=...
pnpm test:live
```

| Variable                 | Is                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PURSER_<ID>_API_KEY`    | The provider's key. `<ID>` is the connector id in capitals: `OPENAI`, `ANTHROPIC`, `OPENROUTER`, `XAI`, `GEMINI`, `MISTRAL`, `GROQ`, `DEEPSEEK`, `AZURE_OPENAI` |
| `PURSER_<ID>_UPSTREAM`   | A different address for the provider. Azure OpenAI needs its resource URL here                                                                                  |
| `PURSER_LIVE_<ID>_MODEL` | A model other than the connector's test model. Azure OpenAI needs its deployment name here                                                                      |
| `PURSER_LIVE_REPORT`     | A file to write the report to, as well as printing it                                                                                                           |

Providers without a key are skipped and listed as such. Keys are never printed or written
to the report.

**What it costs.** Each provider gets three short calls on a small, cheap model: a fraction
of a cent each. The longest is the stop check, which asks for a count to 300 and is cut
after a few words.

It never runs in CI or with `pnpm test`, since it spends money and needs real keys.

## Results

Run it before a release and paste the report here, newest first.

_No full run yet. OpenRouter was checked by hand through the gateway before this check
existed._

## Checking the check

`PURSER_LIVE_MOCK_SLOW=100` with keys and upstreams pointed at the test mock
(`apps/server/src/test/mock-upstream.ts`, served on a local port) runs every check with
no network and no cost. The mock's streams are otherwise too fast to stop mid-way.
