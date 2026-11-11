# Releasing the TypeScript SDK

Applications, including TiDB Link's own DevHub, depend on published versions of
`@tidblink/sdk` from npm. A commit on `main` is not a release.

## Versions and channels

Releases use SemVer and remain `0.x` while the TiDB Link HTTP API is pre-1.0.
A minor version may remove or change public API; a patch version only fixes or
adds. Only the newest minor version is maintained. Do not release SDK `1.0`
until the public TiDB Link HTTP contract is declared stable.

| npm dist-tag | Version form | Service it targets |
| --- | --- | --- |
| `latest` | `0.4.0` | The service deployed to production |
| `next` | `0.4.0-rc.1` | Service `main`, or a service change that has not merged yet |

Consumers pin an exact version and upgrade through their own change.

## How a release happens

Merging a release pull request to `main` publishes it. Nobody pushes tags or
runs `npm publish` by hand.

1. Confirm `typescript/package.json` declares the supported TiDB Link API
   version and exact service revision, and that its fingerprints, exported values
   and frozen contracts agree. The package README must accurately describe the
   supported scope and verification limits.
2. Run the local checks in `CONTRIBUTING.md`. Verify the full supported surface
   and composed quickstart with `npm run test:service` on the service's Node.js 26
   runtime and a dedicated test database as documented in the package README, and
   put that evidence in the pull request. Frozen contracts alone do not replace
   actual-service evidence.
3. Open a release pull request that sets `version` in `typescript/package.json`
   and gives that exact version its own `## <version>` section in `CHANGELOG.md`,
   moving the entries out of the unreleased section. The pull request check
   "Show what merging this commit would release" prints the outcome.
4. Merge it. The release workflow repeats the checks, publishes the package with
   provenance to `next` for a prerelease version or `latest` otherwise, creates
   the `typescript-v<version>` tag, and creates a GitHub Release containing the
   changelog section and the service compatibility mapping.

A version without its own changelog section is treated as still in development
and is not published. A version whose tag exists is never published again; fix
a bad release with a new version and `npm deprecate` the bad one. If a run fails
after publishing to npm, rerun it: it skips the publish and creates the missing
tag and GitHub Release.

## Coordinating a breaking service change

1. Release a prerelease SDK version to `next` that matches the service change's
   contract.
2. The service change upgrades its in-repository consumers to that prerelease.
3. After the service change is deployed to production, release the stable
   version to `latest`, and upgrade consumers again.

## npm authentication

The package belongs to the `@tidblink` npm organization. The workflow
authenticates with npm trusted publishing: the package's npm settings name the
GitHub repository `mem9-ai/agent-stack-sdk` and the workflow file
`release-typescript.yml`. No long-lived token is needed once this is configured.

npm configures a trusted publisher on an existing package, so the first
publication of a new package name needs an `NPM_TOKEN` repository secret that can
publish to `@tidblink`. Remove the secret after the trusted publisher is set up.
