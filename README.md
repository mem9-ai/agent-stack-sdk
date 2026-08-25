# Agent Stack SDKs

Official, supported SDKs for Agent Stack.

The TypeScript SDK lives in [`typescript/`](typescript/). It targets Node.js
22.12 or newer, uses the platform `fetch` and Web Streams APIs, and has no
runtime dependencies.

The SDK is pre-1.0 while the Agent Service HTTP API remains pre-1.0. Each SDK
release declares the Agent Service API version it supports.

## Development

```sh
npm install
npm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
