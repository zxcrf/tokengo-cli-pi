# Releasing tokengo

tokengo is distributed only as GitHub release binaries of `zxcrf/tokengo-cli`. Nothing is published to npm.
Upstream Pi workspace versions stay in lockstep at `1.0.0`; fork releases use prerelease tags such as `v1.0.0-tokengo.1`.

1. Bump all workspace packages to the release version and sync internal dependency ranges:

   ```bash
   npm version 1.0.0-tokengo.2 --workspaces --no-git-tag-version --no-workspaces-update
   node scripts/sync-versions.js
   npm install --package-lock-only --ignore-scripts
   npm run shrinkwrap:coding-agent && npm run install-lock:coding-agent
   ```

2. Optionally add a `## [1.0.0-tokengo.2]` section to `packages/coding-agent/CHANGELOG.md`.
   Without it the release notes fall back to a one-line placeholder.
3. Run `npm run check`, commit, then tag and push: `git tag v1.0.0-tokengo.2 && git push origin main v1.0.0-tokengo.2`.
4. Only tags matching `^v\d+\.\d+\.\d+-tokengo\.\d+$` start the pipeline; the workflow also validates the tag. The `Build Binaries` workflow builds every platform, smoke-tests the archives and the install scripts,
   stages a draft release with `SHA256SUMS`, then publishes it.

Do not use `scripts/release.mjs` (it targets npm and plain `x.y.z` versions).

`tokengo update` and the install scripts read `releases/latest`, so keep fork releases as normal (non-prerelease) GitHub releases.
