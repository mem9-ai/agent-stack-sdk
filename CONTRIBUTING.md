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

The cross-repository check also needs the pinned contract artifact containing
`openapi.json` and `metadata.json`:

```sh
TIDB_LINK_CONTRACT=/path/to/contract npm run test:service-contract
```

CI downloads that immutable public artifact automatically.

Tests exercise public package behavior through a local HTTP boundary. Keep the
package free of runtime dependencies and do not commit credentials, recorded
production responses, or plaintext API Keys.

TiDB Link OpenAPI is the public contract source. CI verifies the package
against the immutable service revision declared in `typescript/package.json`.
A public API change updates that service contract first, then updates the SDK,
its compatibility declaration, tests, quick start, and release notes together.

Open an issue before adding a new product area. The SDK intentionally exposes a
narrow supported surface rather than every TiDB Link route.
