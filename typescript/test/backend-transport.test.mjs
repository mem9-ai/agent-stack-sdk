import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  BackendTransport,
  backendConnectionUrl,
} from "../dist/backend-connection.js";
import {
  BackendConnectionClosedError,
  BackendRequestError,
  ConnectionError,
  TiDBLinkError,
} from "../dist/errors.js";
import { backendServer } from "./support/backend-server.mjs";

const apiKey = "ti_org_backend_" + "x".repeat(43);
const servers = [];
after(() => Promise.all(servers.map((server) => server.close())));
const start = async (options) => {
  const server = await backendServer(options);
  servers.push(server);
  return server;
};
const open = (server, input = {}) =>
  BackendTransport.open({
    url: server.url,
    apiKey,
    onNotification: () => undefined,
    ...input,
  });

test("the Backend Connection URL follows the base URL's scheme and path", () => {
  assert.equal(
    backendConnectionUrl("https://link.example.com"),
    "wss://link.example.com/api/v1/org/backend/ws",
  );
  assert.equal(
    backendConnectionUrl("http://127.0.0.1:3000/prefix/"),
    "ws://127.0.0.1:3000/prefix/api/v1/org/backend/ws",
  );
});

test("a transport authenticates in the upgrade headers, waits for hello and pairs answers by id", async () => {
  const server = await start();
  const transport = await open(server);
  const peer = await server.connection(0);
  assert.equal(peer.request.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(peer.request.headers["sec-websocket-protocol"], "tidb-link.backend.v1");
  assert(!peer.request.url.includes(apiKey));
  assert.equal(transport.hello.maxSessions, 1024);
  assert.equal(transport.hello.claimWindowMs, 5000);

  const first = transport.request("session.attach", { sessionId: "s1" });
  const second = transport.request("session.attach", { sessionId: "s2" });
  const a = await peer.next();
  const b = await peer.next();
  assert.deepEqual(a, {
    jsonrpc: "2.0",
    id: a.id,
    method: "session.attach",
    params: { sessionId: "s1" },
  });
  assert.notEqual(a.id, b.id);
  // Answers may arrive in any order.
  peer.send({
    jsonrpc: "2.0",
    id: b.id,
    error: { code: -32000, message: "Refused", data: { reason: "connection_full" } },
  });
  peer.send({ jsonrpc: "2.0", id: a.id, result: { generation: 3, cursor: "9" } });
  assert.deepEqual(await first, { generation: 3, cursor: "9" });
  await assert.rejects(
    second,
    (error) =>
      error instanceof BackendRequestError &&
      error instanceof TiDBLinkError &&
      error.code === -32000 &&
      error.reason === "connection_full",
  );
  assert.equal(transport.pendingRequests, 0);
  transport.close();
  assert.equal((await peer.closed).code, 1000);
  assert.equal((await transport.closed).code, 1000);
  assert.equal(transport.open, false);
  await assert.rejects(transport.request("tool.claim", { callId: "c" }), BackendConnectionClosedError);
});

test("notifications arrive in order, and core requests are answered as unknown methods", async () => {
  const received = [];
  const server = await start();
  const transport = await open(server, {
    onNotification: (method, params) => received.push([method, params]),
  });
  const peer = await server.connection(0);
  peer.send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s", cursor: "1" } });
  peer.send({ jsonrpc: "2.0", method: "connection.drain", params: { closeAfterMs: 10 } });
  peer.send({ jsonrpc: "2.0", id: "core-1", method: "future.request", params: {} });
  assert.deepEqual(await peer.next(), {
    jsonrpc: "2.0",
    id: "core-1",
    error: { code: -32601, message: "Method not found" },
  });
  assert.deepEqual(received, [
    ["session.event", { sessionId: "s", cursor: "1" }],
    ["connection.drain", { closeAfterMs: 10 }],
  ]);
  transport.close();
});

test("a core close ends the transport and rejects requests in flight; 4001 is not retryable", async () => {
  const server = await start();
  const transport = await open(server);
  const peer = await server.connection(0);
  const pending = transport.request("tool.result", { callId: "c", output: "ok" });
  await peer.next();
  peer.close(4001, "revoked");
  const closed = await transport.closed;
  assert(closed instanceof BackendConnectionClosedError);
  assert(closed instanceof ConnectionError);
  assert.equal(closed.code, 4001);
  assert.equal(closed.reason, "revoked");
  assert.equal(closed.retryable, false);
  await assert.rejects(pending, (error) => error === closed);
});

test("a drained or restarted replica's close is retryable", async () => {
  const server = await start();
  const transport = await open(server);
  (await server.connection(0)).close(1012, "drained");
  const closed = await transport.closed;
  assert.equal(closed.code, 1012);
  assert.equal(closed.retryable, true);
});

test("opening fails with the close code when the core refuses the Key before hello", async () => {
  const server = await start({
    sendHello: false,
    onConnection: (peer) => peer.close(4001, "authentication failed"),
  });
  await assert.rejects(
    open(server),
    (error) =>
      error instanceof BackendConnectionClosedError &&
      error.code === 4001 &&
      !error.retryable,
  );
});

test("opening fails when the upgrade is refused or the first message is not hello", async () => {
  const refused = await start({ reject: () => 503 });
  await assert.rejects(
    open(refused),
    (error) => error instanceof BackendConnectionClosedError && error.retryable,
  );
  const garbled = await start({
    sendHello: false,
    onConnection: (peer) =>
      peer.send({ jsonrpc: "2.0", method: "hello", params: { connectionId: "x" } }),
  });
  await assert.rejects(
    open(garbled),
    (error) => error instanceof BackendConnectionClosedError && /hello/.test(error.message),
  );
  const silent = await start({ sendHello: false });
  await assert.rejects(
    open(silent, { openTimeoutMs: 50 }),
    (error) => error instanceof BackendConnectionClosedError && /no hello/.test(error.message),
  );
});

test("a request larger than the announced frame limit is refused before sending", async () => {
  const server = await start({ helloParams: { maxFrameBytes: 64 } });
  const transport = await open(server);
  await assert.rejects(
    transport.request("tool.result", { callId: "c", output: "x".repeat(100) }),
    (error) => error instanceof TiDBLinkError && /frame limit of 64 bytes/.test(error.message),
  );
  transport.close();
});

test("a silent connection is probed with ping and closed when the probe goes unanswered", async () => {
  const server = await start({ helloParams: { heartbeatMs: 1000 } });
  const transport = await open(server);
  const peer = await server.connection(0);
  // Any answer to the probe keeps the connection, even "method not found".
  const probe = await peer.next();
  assert.equal(probe.method, "ping");
  peer.send({ jsonrpc: "2.0", id: probe.id, error: { code: -32601, message: "Method not found" } });
  assert.equal((await peer.next()).method, "ping");
  // The second probe goes unanswered.
  const closed = await transport.closed;
  assert.equal(closed.code, 4000);
  assert.equal(closed.retryable, true);
  assert.equal((await peer.closed).code, 4000);
});
