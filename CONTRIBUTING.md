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

Tests exercise public package behavior through a local HTTP boundary. Keep the
package free of runtime dependencies and do not commit credentials, recorded
production responses, or plaintext API Keys.

Agent Service OpenAPI is the public contract source. A public API change must
update the service contract first, then update this SDK, its compatibility
declaration, tests, quick start, and release notes together.

Open an issue before adding a new product area. The SDK intentionally exposes a
narrow supported surface rather than every Agent Service route.
