# Releasing the TypeScript SDK

TypeScript releases use SemVer and remain `0.x` while the TiDB Link HTTP API
is pre-1.0.

1. Confirm `typescript/package.json` declares the supported TiDB Link API
   version and exact service revision, and that its fingerprints, exported values
   and frozen contracts agree. The package README must accurately describe the
   supported scope and verification limits.
2. Update the package version and release notes.
3. Run the local checks in `CONTRIBUTING.md`; CI verifies the installed artifact
   on Node.js 22.12. Verify the full supported surface and composed quickstart with
   `npm run test:service` on the service's Node.js 26 runtime and a dedicated test
   database as documented in the package README. Frozen contracts alone do not
   replace actual-service evidence.
4. Create an annotated tag named `typescript-v<version>`, for example
   `typescript-v0.3.0`.
5. Push the tag. The release workflow verifies the packed package and publishes
   it to npm.

Do not release SDK `1.0` until the public TiDB Link HTTP contract is
declared stable.
