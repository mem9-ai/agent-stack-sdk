# Contributing

## Requirements

- Node.js 22.12 or newer
- npm 11 or newer

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run pack:check
```

The frozen selected SDK contract checks use committed exact-service snapshots:

```sh
npm run test:service-contract
```

For actual compatibility across the supported package surface,
run `npm run test:service` with the exact service checkout and a dedicated TiDB
test database; setup is in [the package README](typescript/README.md#compatibility-and-verification).
This verifies the installed packed SDK and its examples against the actual service.
The service runner discovers each `*.fixture.ts` with neighboring `*.cases.mjs`
and runs those distinct dependency lifecycles sequentially. Every case must have
exactly one fixture owner. The default HTTP tests supplement reproducible failure cases. Keep the
package free of runtime dependencies and do not commit credentials, recorded
production responses, or plaintext API Keys.

TiDB Link OpenAPI is the public contract source. CI verifies the selected frozen contracts. The service revision and OpenAPI
fingerprint in `typescript/package.json` identify the actual-service baseline.
Contract snapshots supplement actual-service execution evidence.
A public API change updates that service contract first, then updates the SDK,
its compatibility declaration, tests, quick start, and release notes together.

Open an issue before adding a new product area. The SDK intentionally exposes a
narrow supported surface rather than every TiDB Link route.
