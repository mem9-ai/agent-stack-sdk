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

Merging a release pull request to `main` submits the version to npm. A
maintainer then approves it on npm with two-factor authentication. Nobody pushes
tags or runs `npm publish` by hand, and automation alone cannot make a version
public.

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
4. Merge it. The release workflow repeats the checks and stages the package on
   npm with provenance, using dist-tag `next` for a prerelease version or `latest`
   otherwise. It also creates a draft GitHub Release that holds the changelog
   section, the service compatibility mapping and the released commit. The
   version is not public yet.
5. A maintainer with publish access reviews the staged version under Staged
   Packages on npmjs.com, or with `npm stage view` and `npm stage download`, and
   approves it there or with `npm stage approve <stage-id>`.
6. Run the release workflow again from the Actions page, or let the next push to
   `main` run it. It sees the version on npm, creates the `typescript-v<version>`
   tag at the staged commit and publishes the GitHub Release.

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
write (stage only)" permission for that organization, so a leaked token cannot
publish a version.

Staged publishing needs npm 11.15.0 or newer. The first staged version of a new
package name makes npm create a public placeholder version, `0.0.0-stage`.

After the package exists, configure npm trusted publishing in the package's npm
settings for the GitHub repository `mem9-ai/tidblink-sdk` and the workflow file
`release-typescript.yml`, allowing staged publishing only, then delete the
`NPM_TOKEN` secret.
