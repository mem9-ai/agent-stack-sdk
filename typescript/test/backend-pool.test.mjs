import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { BackendConnectionPool } from "../dist/backend-pool.js";
import {
  BackendConnectionClosedError,
  BackendRequestError,
  TiDBLinkError,
} from "../dist/errors.js";
import { backendServer } from "./support/backend-server.mjs";

const apiKey = "ti_org_pool_" + "x".repeat(43);
const servers = [];
const pools = [];
after(async () => {
  await Promise.all(pools.map((pool) => pool.close()));
  await Promise.all(servers.map((server) => server.close()));
});

const attachAnswer = (message) => ({
  result: { generation: 1, cursor: message.params.cursor ?? "0" },
});
/**
 * A server whose connections record every client message in `peer.log` and
 * answer through `respond(message, peer, index)`; the default answers
 * attach, detach and ping.
 */
const start = async ({ respond, ...options } = {}) => {
  let count = 0;
  const server = await backendServer({
    ...options,
    onConnection: (peer) => {
      const index = count++;
      peer.log = [];
      options.onConnection?.(peer);
      void (async () => {
        for (;;) {
          const message = await peer.next();
          peer.log.push(message);
          const answer =
            (await respond?.(message, peer, index)) ??
            (message.method === "session.attach"
              ? attachAnswer(message)
              : message.method === "session.detach"
                ? { result: {} }
                : message.method === "ping"
                  ? { error: { code: -32601, message: "Method not found" } }
                  : undefined);
          if (answer && answer !== "silent")
            peer.send({ jsonrpc: "2.0", id: message.id, ...answer });
        }
      })();
    },
  });
  servers.push(server);
  return server;
};
const poolFor = (server, options = {}) => {
  const pool = new BackendConnectionPool({
    baseUrl: server.baseUrl,
    apiKey,
    idleCloseMs: 50,
    ...options,
  });
  pools.push(pool);
  return pool;
};
const attachment = (sessionId, extra = {}) => {
  const record = {
    sessionId,
    cursor: undefined,
    attachedTo: [],
    notes: [],
    ends: [],
    attachParams: () => ({
      userId: "user_1",
      sessionId,
      ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
      ...extra,
    }),
    attached(result, link) {
      record.attachedTo.push({ result, link });
    },
    notify(method, params) {
      record.notes.push([method, params]);
    },
    ended(end) {
      record.ends.push(end);
    },
  };
  return record;
};
const until = async (predicate, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(10);
  }
};
const methods = (peer) => peer.log.map((message) => message.method);

test("attachments share a connection up to maxSessions, then open another", async () => {
  const server = await start({ helloParams: { maxSessions: 2 } });
  const pool = poolFor(server);
  const sessions = ["s1", "s2", "s3"].map((id) => attachment(id, { tools: [] }));
  const results = await Promise.all(sessions.map((a) => pool.attach(a)));
  assert.deepEqual(results[0], { generation: 1, cursor: "0" });
  assert.equal(pool.connections, 2);
  const [first, second] = server.peers;
  await until(() => first.log.length + second.log.length === 3);
  assert.deepEqual(
    [...first.log, ...second.log].map((message) => message.params).sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    ),
    [
      { userId: "user_1", sessionId: "s1", tools: [] },
      { userId: "user_1", sessionId: "s2", tools: [] },
      { userId: "user_1", sessionId: "s3", tools: [] },
    ],
  );
  assert.equal(first.log.length, 2);
  for (const a of sessions) assert.equal(a.attachedTo.length, 1);
});

test("a connection_full refusal moves the attach to another connection and the empty one closes", async () => {
  const server = await start({
    respond: (message, _, index) =>
      message.method === "session.attach" && index === 0
        ? {
            error: { code: -32000, message: "Refused", data: { reason: "connection_full" } },
          }
        : undefined,
  });
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  assert.equal(server.peers.length, 2);
  assert.equal(a.attachedTo.length, 1);
  assert.equal((await server.peers[0].closed).code, 1000);
  assert.equal(pool.connections, 1);
});

test("notifications reach the attachment holding their Session; session.detached ends it without retry", async () => {
  const server = await start();
  const pool = poolFor(server);
  const a = attachment("s1");
  const b = attachment("s2");
  await pool.attach(a);
  await pool.attach(b);
  const peer = server.peers[0];
  peer.send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", cursor: "3", event: {} } });
  peer.send({ jsonrpc: "2.0", method: "tool.call", params: { sessionId: "s9", callId: "c" } });
  peer.send({ jsonrpc: "2.0", method: "session.detached", params: { sessionId: "s1", reason: "superseded" } });
  peer.send({ jsonrpc: "2.0", method: "session.detached", params: { sessionId: "s2", reason: "session_deleted" } });
  await until(() => a.ends.length && b.ends.length);
  assert.deepEqual(a.notes, [["session.event", { sessionId: "s1", cursor: "3", event: {} }]]);
  assert.deepEqual(a.ends, [{ reason: "superseded" }]);
  assert.deepEqual(b.ends, [{ reason: "session_deleted" }]);
  await delay(100);
  assert.equal(methods(peer).filter((m) => m === "session.attach").length, 2);
  // The Session can be connected again.
  await pool.attach(attachment("s1"));
});

test("a lost connection re-attaches each Session with fresh parameters on a new connection", async () => {
  const server = await start();
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  a.cursor = "7";
  server.peers[0].destroy();
  const replacement = await server.connection(1);
  await until(() => a.attachedTo.length === 2);
  assert.deepEqual(replacement.log[0].params, { userId: "user_1", sessionId: "s1", cursor: "7" });
  assert.equal(a.attachedTo[1].link.open, true);
  assert.deepEqual(a.ends, []);
  replacement.send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", cursor: "8" } });
  await until(() => a.notes.length === 1);
});

test("connection.drain moves attachments to a new connection, ignores the old one and closes it", async () => {
  const server = await start();
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  const old = server.peers[0];
  old.send({ jsonrpc: "2.0", method: "connection.drain", params: { closeAfterMs: 5000 } });
  const next = await server.connection(1);
  await until(() => a.attachedTo.length === 2);
  assert.equal(next.log[0].method, "session.attach");
  old.send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", cursor: "1" } });
  next.send({ jsonrpc: "2.0", method: "session.event", params: { sessionId: "s1", cursor: "2" } });
  await until(() => a.notes.length === 1);
  assert.equal(a.notes[0][1].cursor, "2");
  assert.equal((await old.closed).code, 1000);
  // New attachments avoid the draining connection.
  await pool.attach(attachment("s2"));
  assert.equal(methods(old).filter((m) => m === "session.attach").length, 1);
});

test("a revoked Key ends attachments for good and refuses new ones", async () => {
  let revoked = false;
  const server = await start({
    sendHello: true,
    onConnection: (peer) => {
      if (revoked) peer.close(4001, "authentication failed");
    },
  });
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  revoked = true;
  server.peers[0].close(4001, "revoked");
  await until(() => a.ends.length === 1);
  assert.equal(a.ends[0].reason, "error");
  assert(a.ends[0].error instanceof BackendConnectionClosedError);
  assert.equal(a.ends[0].error.code, 4001);
  await assert.rejects(
    pool.attach(attachment("s2")),
    (error) => error instanceof BackendConnectionClosedError && error.code === 4001,
  );
});

test("a refused first attach rejects, and one Session connects once per client", async () => {
  const server = await start({
    respond: (message) =>
      message.params?.sessionId === "missing"
        ? {
            error: { code: -32000, message: "Refused", data: { reason: "session_not_found" } },
          }
        : undefined,
  });
  const pool = poolFor(server);
  await assert.rejects(
    pool.attach(attachment("missing")),
    (error) => error instanceof BackendRequestError && error.reason === "session_not_found",
  );
  const first = pool.attach(attachment("s1"));
  await assert.rejects(
    pool.attach(attachment("s1")),
    (error) => error instanceof TiDBLinkError && /already connected/.test(error.message),
  );
  await first;
  // A refused Session can be tried again.
  await assert.rejects(pool.attach(attachment("missing")), BackendRequestError);
});

test("detach releases the Session, and a connection that holds nothing closes", async () => {
  const server = await start();
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  await pool.detach(a);
  const peer = server.peers[0];
  assert.deepEqual(peer.log.at(-1), {
    jsonrpc: "2.0",
    id: peer.log.at(-1).id,
    method: "session.detach",
    params: { sessionId: "s1" },
  });
  assert.equal((await peer.closed).code, 1000);
  assert.equal(pool.connections, 0);
  assert.deepEqual(a.ends, []);
});

test("request() retries an idempotent request on a new connection after a lost one", async () => {
  const server = await start({
    respond: (message, peer, index) => {
      if (message.method !== "tool.result") return undefined;
      if (index === 0) {
        peer.destroy();
        return "silent";
      }
      return { result: { accepted: true } };
    },
  });
  const pool = poolFor(server);
  const params = { callId: "call_1", output: "done" };
  assert.deepEqual(
    await pool.request("tool.result", params, { retryUntil: Date.now() + 5000 }),
    { accepted: true },
  );
  assert.deepEqual(server.peers[1].log.at(-1).params, params);
  // Without retryUntil a lost connection is the caller's to handle.
  const lone = await start({
    respond: (message, peer) => {
      if (message.method !== "tool.result") return undefined;
      peer.destroy();
      return "silent";
    },
  });
  await assert.rejects(
    poolFor(lone).request("tool.result", params),
    BackendConnectionClosedError,
  );
});

test("close() detaches every Session, ends them as closed and refuses later attaches", async () => {
  const server = await start();
  const pool = poolFor(server);
  const a = attachment("s1");
  await pool.attach(a);
  await pool.close();
  assert.deepEqual(a.ends, [{ reason: "closed" }]);
  assert(methods(server.peers[0]).includes("session.detach"));
  assert.equal((await server.peers[0].closed).code, 1000);
  await assert.rejects(pool.attach(attachment("s2")), /closed/);
});
