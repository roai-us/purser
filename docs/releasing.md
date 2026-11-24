# Releasing

A version tag publishes everything:

- `@roai-us/purser` on npm, which is what `npx @roai-us/purser` runs
- `@roai-us/roi-core` on npm, when its version is new
- `ghcr.io/roai-us/purser`, the Docker image, for amd64 and arm64

## Steps

1. In a pull request, set `version` in `apps/server/package.json`, for example
   `0.1.0-alpha.2`. If the ROI math changed, bump `packages/roi-core/package.json` too.
   Merge it once CI passes.
2. Tag that commit on `main` with the same version and a `v` in front, and push the tag:

   ```bash
   git tag v0.1.0-alpha.2
   git push origin v0.1.0-alpha.2
   ```

3. Watch the Release and Docker workflows. Each refuses a tag that doesn't match the
   server's version. The release workflow runs the full check again, publishes, then
   runs the new version with `npx` from a clean folder.

## How npm trusts the release

npm publishes with **trusted publishing**: npm checks that the request comes from
`release.yml` in `roai-us/purser`, so no npm token is stored anywhere. Each package's
settings on npmjs.com name this repository and workflow under Trusted Publisher, and
require two-factor authentication with tokens disallowed. Every package is published
with provenance, which links it to the workflow run that built it.

A new package can't use trusted publishing until it exists on npm. To add a package
to the release, publish its first version by hand, set up its trusted publisher, then
add it to `release.yml`.

The Docker image is public. GitHub makes a new organization package private; if the
image is ever recreated, set it public again under the package's settings.

## Checks on every pull request

Releases should hold no surprises. On every pull request, CI packs both npm packages,
installs them with npm into an empty folder and starts Purser from them, and the Docker
workflow builds the image and runs it.
