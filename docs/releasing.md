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

## Before the first release

The release workflow publishes to npm with a token kept as the repository secret
`NPM_TOKEN`. Create it once:

1. Sign in to npmjs.com as an owner of the `roai-us` organization.
2. Create a granular access token that can read and write the `@roai-us` packages,
   with an expiry date.
3. Save it in GitHub under the repository's Settings, Secrets and variables, Actions,
   as `NPM_TOKEN`.

Once both packages exist on npm, a token is no longer needed: set up trusted publishing
for each package on npmjs.com, pointing at this repository and `release.yml`, then
delete the token and the secret.

Every package is published with provenance, which links it to the workflow run that
built it.

## Checks on every pull request

Releases should hold no surprises. On every pull request, CI packs both npm packages,
installs them with npm into an empty folder and starts Purser from them, and the Docker
workflow builds the image and runs it.
