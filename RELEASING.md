# Releasing the TypeScript SDK

Applications, including TiDB Link's own DevHub, depend on published versions of
`@tidblink/server` from npm. A commit on `main` is not a release.

`@tidblink/server` is the package for backends that hold an Organization API
Key. Packages in this repository are maintained together and released
separately: each has its own version, npm package and `<package>@<version>`
tags.

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

## Branches

`main` is the development branch. Nothing is released from it, whatever its
package version and changelog say.

`release` is the release branch. Its head is the latest commit submitted to npm.
A release is made by merging `main` into `release` through a pull request. Use
"Create a merge commit", not squash, so that later releases merge cleanly.

A `release-<minor>` branch, for example `release-0.3`, is created from `release`
only when an older minor version needs a fix after `main` has moved on. It
releases the same way.

## How a release happens

Merging into a release branch submits the version to npm. A maintainer then
approves it on npm with two-factor authentication. Nobody pushes tags or runs
`npm publish` by hand, and automation alone cannot make a version public.

1. Confirm `typescript/package.json` declares the supported TiDB Link API
   version and exact service revision, and that its fingerprints, exported values
   and frozen contracts agree. The package README must accurately describe the
   supported scope and verification limits.
2. Run the local checks in `CONTRIBUTING.md`. Verify the full supported surface
   and composed quickstart with `npm run test:service` on the service's Node.js 26
   runtime and a dedicated test database as documented in the package README, and
   put that evidence in the pull request. Frozen contracts alone do not replace
   actual-service evidence.
3. On `main`, merge a pull request that sets `version` in
   `typescript/package.json` and gives that exact version its own `## <version>`
   section in `CHANGELOG.md`, moving the entries out of the unreleased section.
   This releases nothing.
4. Open a pull request from `main` into `release`. Its check "Show what this
   commit would release from a release branch" prints the outcome. Merge it with
   a merge commit.
5. The release workflow repeats the checks and stages the package on npm with
   provenance, using dist-tag `next` for a prerelease version or `latest`
   otherwise. It also creates a draft GitHub Release that holds the changelog
   section, the service compatibility mapping and the released commit. The
   version is not public yet.
6. A maintainer with publish access reviews the staged version under Staged
   Packages on npmjs.com, or with `npm stage view` and `npm stage download`, and
   approves it there or with `npm stage approve <stage-id>`.
7. Run the release workflow again on the release branch from the Actions page.
   It sees the version on npm, creates the `@tidblink/server@<version>` tag at
   the staged commit and publishes the GitHub Release.

A version without its own changelog section is treated as still in development
and is not staged. A staged version is not staged twice while its draft GitHub
Release exists. A version whose tag exists is never released again; fix a bad
release with a new version and `npm deprecate` the bad one.

To abandon a staged version, reject it on npm and delete its draft GitHub
Release. If the workflow fails after staging but before creating the draft,
reject the staged version on npm and rerun the workflow.

## Coordinating a breaking service change

1. Release a prerelease SDK version to `next` that matches the service change's
   contract.
2. The service change upgrades its in-repository consumers to that prerelease.
3. After the service change is deployed to production, release the stable
   version to `latest`, and upgrade consumers again.

## npm authentication

The package belongs to the `@tidblink` npm organization. The workflow can only
stage: the `NPM_TOKEN` repository secret is a granular token with "Read and
write (stage only)" permission for that organization. A leaked token cannot
publish a version, though it can still deprecate versions and move dist-tags.
Replace the secret before the token expires.

Staged publishing needs npm 11.15.0 or newer. The first staged version of a new
package name makes npm create a public placeholder version, `0.0.0-stage`, which
holds `latest` until the first stable release.

npm trusted publishing is an optional replacement for the token. It is
configured in the package's npm settings for the GitHub repository
`mem9-ai/tidblink-sdk` and the workflow file `release-typescript.yml`, allowing
staged publishing only. It removes the stored secret and its expiry; a
maintainer's approval is required either way.
