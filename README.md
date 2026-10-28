# TiDB Link SDKs

Official, supported SDKs for TiDB Link.

The TypeScript SDK lives in [`typescript/`](typescript/README.md). It targets Node.js
22.12 or newer, uses the platform `fetch` API, and has no
runtime dependencies.

- [TypeScript quick start](typescript/README.md#quick-start)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

The SDK is pre-1.0 while the TiDB Link HTTP API remains pre-1.0. Each SDK
release declares its service baselines and supported scope. The current refresh
covers Organization/End User/Key provisioning, Template discovery, personal Agent
and Session management, text commands with recoverable final results, continuous
progress, Client Tools, explicit cancellation and checkpoint retry, conversation
history, verified file attachments and downloads, Schedulers, and Realtime
Model/Connection preparation against one
exact service revision. See the TypeScript README for the supported boundaries
and the remaining capabilities reserved for later slices.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
