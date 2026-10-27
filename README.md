# TiDB Link SDKs

Official, supported SDKs for TiDB Link.

The TypeScript SDK lives in [`typescript/`](typescript/README.md). It targets Node.js
22.12 or newer, uses the platform `fetch` and Web Streams APIs, and has no
runtime dependencies.

- [TypeScript quick start](typescript/README.md#quick-start)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

The SDK is pre-1.0 while the TiDB Link HTTP API remains pre-1.0. Each SDK
release declares its service baselines and supported scope. The current refresh
verifies Organization/End User/Key provisioning against a newer revision; see the
TypeScript README before using retained exports.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
