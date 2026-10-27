# Releasing the TypeScript SDK

TypeScript releases use SemVer and remain `0.x` while the Agent Service HTTP API
is pre-1.0.

1. Confirm `typescript/package.json` declares the supported Agent Service API
   version, exact revision and OpenAPI fingerprint, and verify the exported version
   and revision match. The package README must describe only the verified scope.
2. Update the package version and release notes.
3. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run pack:check` on
   Node.js 22.12 or newer. Run `npm run test:service` with the selected service
   checkout and its required Node.js 26 runtime, as described in the package README.
   Passing the release workflow alone does not replace actual-service evidence.
4. Create an annotated tag named `typescript-v<version>`, for example
   `typescript-v0.1.0`.
5. Push the tag. The release workflow verifies the packed package and publishes
   it to npm.

Do not release SDK `1.0` until the public Agent Service HTTP contract is
declared stable.
