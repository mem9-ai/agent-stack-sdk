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

The frozen text/history and file-transfer contract check uses the committed exact-service snapshot:

```sh
npm run test:service-contract
```

For current provisioning, Template/Agent/Session management, text/results/history, file attachments and Realtime preparation,
run `npm run test:service` with the exact service checkout and a dedicated TiDB
test database; setup is in [the package README](typescript/README.md#compatibility-and-verification).
This verifies the installed packed SDK and its examples against the actual service.
The default HTTP tests supplement reproducible failure cases. Keep the
package free of runtime dependencies and do not commit credentials, recorded
production responses, or plaintext API Keys.

TiDB Link OpenAPI is the public contract source. CI verifies the frozen text/history and file-transfer contracts. The slice revisions and OpenAPI
fingerprints in `typescript/package.json` identify the actual-service baselines.
Contract snapshots supplement actual-service execution evidence.
A public API change updates that service contract first, then updates the SDK,
its compatibility declaration, tests, quick start, and release notes together.

Open an issue before adding a new product area. The SDK intentionally exposes a
narrow supported surface rather than every TiDB Link route.
