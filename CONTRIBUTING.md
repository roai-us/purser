# Contributing to ROAI Purser

Thanks for helping. Purser holds people's AI provider keys and decides whether their
agents may run, so we keep the bar high and the surface small.

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs and small fixes:** open a pull request.
- **New features or connectors:** open an issue first so we can agree on scope. The
  [roadmap](docs/roadmap.md) says what is planned and in what order.
- **Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development

You need Node 24 or later and pnpm 10.

```bash
pnpm install
pnpm check
```

`pnpm check` must pass before a pull request is merged. It runs the type check, ESLint,
Prettier and the tests with coverage.

## Rules

1. **Tests ship with the code.** The ROI math, the key handling and the kill path keep
   100% coverage. Everything else needs meaningful tests.
2. **No math in UI components.** Calculations live in pure, tested functions.
3. **Limits are enforced on the server.** A limit that only exists in the interface is
   not a limit.
4. **Agents never reach the admin surface.** An agent key must not be able to read,
   change or stop anything in Purser.
5. **No prompt content by default.** Anything that stores request or response content
   must be opt-in per agent, with a retention period.
6. **No telemetry.** Purser makes no network calls except the ones the user configured.
7. **Keep dependencies few.** Every new runtime dependency needs a reason in the pull
   request.
8. **Plain writing.** In docs and UI copy: short sentences, no em dashes, and numbers
   that carry their units and dates.

## Contributor License Agreement

Before we can merge your first pull request, please sign the
[Contributor License Agreement](CLA.md) by adding the comment it describes to your pull
request. You keep ownership of your work. The agreement lets the project distribute it
under the licenses in [LICENSING.md](LICENSING.md), including commercial licenses.

## License

Your contributions are distributed under the [Elastic License 2.0](LICENSE), or the
[Apache License 2.0](packages/roi-core/LICENSE) if they are in `packages/roi-core`. See
[LICENSING.md](LICENSING.md).
