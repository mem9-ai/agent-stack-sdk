# TiDB Link SDKs

Official, supported SDKs for TiDB Link.

The TypeScript SDK lives in [`typescript/`](typescript/). It targets Node.js
22.12 or newer, uses the platform `fetch` and Web Streams APIs, and has no
runtime dependencies.

- [TypeScript quick start](typescript/README.md#quick-start)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

The SDK is pre-1.0 while the TiDB Link HTTP API remains pre-1.0. Each SDK
release declares the exact TiDB Link revision and API version it supports.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
