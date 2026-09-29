# Releasing the TypeScript SDK

TypeScript releases use SemVer and remain `0.x` while the Agent Service HTTP API
is pre-1.0.

1. Confirm `typescript/package.json` declares the supported Agent Service API
   version and exact revision, and the same values are exported by the package.
2. Update the package version and release notes.
3. Run the local checks in `CONTRIBUTING.md`; CI also verifies the pinned Agent
   Service contract on Node.js 22.12.
4. Create an annotated tag named `typescript-v<version>`, for example
   `typescript-v0.2.0`.
5. Push the tag. The release workflow verifies the packed package and publishes
   it to npm.

Do not release SDK `1.0` until the public Agent Service HTTP contract is
declared stable.
