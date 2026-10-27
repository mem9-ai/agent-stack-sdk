# Agent Stack SDKs

Official SDKs for Agent Stack.

The TypeScript SDK lives in [`typescript/`](typescript/). It targets Node.js
22.12 or newer, uses the platform `fetch` and Web Streams APIs, and has no
runtime dependencies.

- [TypeScript quick start](typescript/README.md#quick-start)
- [Contributing](CONTRIBUTING.md)
- [Release process](RELEASING.md)
- [Security policy](SECURITY.md)

The SDK is pre-1.0 while the Agent Service HTTP API remains pre-1.0. Each SDK
release declares its verified service revision and supported scope. The current
refresh verifies Organization/End User/Key provisioning only; see the TypeScript
README before using retained exports.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
