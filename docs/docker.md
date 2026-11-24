# Running ROAI Purser in Docker

One container holds the gateway, the admin API and the web UI. Your data lives in a
Docker volume.

## Start it

```bash
docker run -d --name purser \
  -p 127.0.0.1:4141:4141 \
  -v purser-data:/data \
  ghcr.io/roai-us/purser
docker logs purser
```

The log shows a one-time sign-in link. Open it in your browser within 15 minutes. If
the link has expired, restart the container for a new one (`docker restart purser`),
or sign in with the admin token:

```bash
docker exec purser cat /data/admin-token
```

`-p 127.0.0.1:4141:4141` publishes Purser on this computer only. Keep it that way
unless HTTPS is in front of it (see below).

> **Images are published from the first tagged release.** Until then, build it from a
> checkout: `docker build -t purser .` and use `purser` in place of
> `ghcr.io/roai-us/purser`.

## Settings

Pass any of these with `-e NAME=value`.

| Variable               | Default                 | What it does                                                                                |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `PURSER_BASE_URL`      | `http://localhost:4141` | The address people and agents use. It goes into sign-in links and the base URLs agents copy |
| `PURSER_<ID>_API_KEY`  |                         | A provider key, such as `PURSER_OPENAI_API_KEY`. Keys can also be set in the web UI instead |
| `PURSER_<ID>_UPSTREAM` | the provider's API      | Send a connector's calls somewhere else, such as an Azure OpenAI resource                   |
| `PURSER_ADMIN_TOKEN`   | a file in `/data`       | Set the admin token yourself instead of the generated one                                   |
| `PURSER_PORT`          | `4141`                  | The port inside the container                                                               |

Keys set in the web UI are kept in the volume, readable only by Purser. Prefer that, or
Docker secrets, to putting keys on the command line, where they end up in your shell
history.

## Behind HTTPS, for a team

To share Purser with a team, put it behind a reverse proxy that handles HTTPS, such as
Caddy, nginx or your cloud's load balancer, and tell Purser its public address:

```bash
docker run -d --name purser \
  -p 127.0.0.1:4141:4141 \
  -v purser-data:/data \
  -e PURSER_BASE_URL=https://purser.example.com \
  ghcr.io/roai-us/purser
```

The proxy forwards `https://purser.example.com` to `127.0.0.1:4141`. Sign-in cookies are
marked secure when the address is HTTPS. Company sign-in is set up in the web UI under
Settings ([self-service.md](self-service.md)).

## The command line

The image's entry point is the `roai` command, so other commands work too:

```bash
docker run --rm ghcr.io/roai-us/purser help
docker run --rm -v purser-demo:/data ghcr.io/roai-us/purser demo-seed --agents 300
```

The second line fills a separate volume with a made-up fleet to look around in. Start a
container on `purser-demo` to see it, and sign in with its admin token. The pick-a-person
demo sign-in is not available in Docker, because it has no password and is only allowed
on a server listening on this computer alone.

## Upgrades and backups

- **Upgrade:** `docker pull ghcr.io/roai-us/purser`, then remove and start the container
  again with the same volume.
- **Back up:** everything is in the volume: agents, usage, workflows, results, the audit
  log, the provider key vault and the admin token. Treat a backup as secret.

```bash
docker run --rm -v purser-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/purser-backup.tgz -C /data .
```

## What the image is

- Two stages on `node:24-bookworm-slim`, pinned by digest and kept current by Dependabot.
- It runs as the unprivileged `node` user, never root.
- It stops at once on `docker stop`, because every write is finished before it returns.
- It has a Docker health check on `/health`.
- Each release is built for `linux/amd64` and `linux/arm64`, with provenance and an SBOM.
- Every pull request builds the image and checks it: health, the web UI, the non-root
  user, the sign-in link, the admin token's permissions, a clean stop, and data kept
  across a new container.
