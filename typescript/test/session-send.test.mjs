import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import {
  BackendRequestError,
  InputNotAppliedError,
  OrganizationClient,
  OutcomeUnknownError,
  TiDBLinkError,
  TurnFailedError,
  TurnWaitTimeoutError,
} from "../dist/index.js";
import { backendServer } from "./support/backend-server.mjs";

const apiKey = "ti_org_send_" + "x".repeat(43);
const servers = [];
const clients = [];
after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
});

/** A core stand-in: records messages in `peer.log`, answers attach and detach. */
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
              ? { result: { generation: 4, cursor: "10" } }
              : message.method === "session.detach"
                ? { result: {} }
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
const clientFor = (server) => {
  const client = new OrganizationClient({ baseUrl: server.baseUrl, apiKey });
  clients.push(client);
  return client;
};
const sessionOf = (server, sessionId = "sess_1") =>
  clientFor(server).user("user_1").session(sessionId);
const until = async (predicate, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(10);
  }
};
const at = "2026-11-13T00:00:00.000Z";
const done = "2026-11-13T00:00:02.000Z";
const receipt = (overrides = {}) => ({
  inputId: "msg_1",
  sequence: 1,
  kind: "message",
  mode: "started",
  turnId: "turn_1",
  message: { id: "um_1", role: "user", content: "Too bright", createdAt: at },
  createdAt: at,
  appliedAt: null,
  rejection: null,
  result: { status: "running", completedAt: null },
  ...overrides,
});
const settled = (overrides = {}) =>
  receipt({ appliedAt: at, result: { status: "succeeded", completedAt: done }, ...overrides });
const savedTurn = {
  id: "turn_1",
  sessionId: "sess_1",
  status: "succeeded",
  billingTag: null,
  userMessage: { id: "um_1", role: "user", content: "Too bright", sessionId: "sess_1", turnId: "turn_1", createdAt: at },
  operations: [],
  assistantMessage: { id: "am_1", role: "assistant", content: "Dimmed to 40%.", sessionId: "sess_1", turnId: "turn_1", createdAt: done },
  createdAt: at,
  completedAt: done,
};
const json = (res, value, status = 200) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
/** REST of the stand-in core: the settled interaction and its saved Turn. */
const rest = (calls, interaction = settled()) => (req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.url.endsWith("/turns/turn_1")) return json(res, { turn: savedTurn });
  if (req.url.includes("/interactions/")) return json(res, { interaction });
  res.writeHead(404).end();
};
const turnEvent = (cursor, type, event, payload, turnId = "turn_1") => ({
  jsonrpc: "2.0",
  method: "session.event",
  params: {
    sessionId: "sess_1",
    cursor,
    event: {
      type,
      sessionId: "sess_1",
      turnId,
      createdAt: at,
      data: { event, turnId, sessionId: "sess_1", seq: Number(cursor), createdAt: at, payload },
    },
  },
});
const draft = (cursor, text, turnId) =>
  turnEvent(cursor, "agent.session.turn.output_text.snapshot", "assistant_draft", { text }, turnId);
const finished = (cursor, turnId) =>
  turnEvent(cursor, "agent.session.turn.completed", "turn_finished", { status: "succeeded" }, turnId);
const methodOf = (peer, method) => peer.log.filter((m) => m.method === method);

test("send() submits over the connection, streams drafts and returns the settled answer", async () => {
  const calls = [];
  const server = await start({
    http: rest(calls),
    respond: (message, peer) => {
      if (message.method !== "session.send") return undefined;
      // Events of the Turn may precede the receipt.
      peer.send(draft("11", "Dim"));
      peer.send(draft("12", "Dimmed to"));
      setTimeout(() => {
        peer.send(draft("13", "other turn", "turn_9"));
        peer.send(draft("14", "Dimmed to 40%."));
        peer.send(finished("15"));
      }, 20);
      return { result: { interaction: receipt(), replayed: false } };
    },
  });
  const conn = await sessionOf(server).connect();
  const drafts = [];
  const reply = await conn.send("Too bright", {
    clientEventId: "msg_1",
    billingTag: null,
    onProgress: (text) => drafts.push(text),
  });
  assert.equal(reply.type, "answer");
  assert.equal(reply.text, "Dimmed to 40%.");
  assert.equal(reply.turnId, "turn_1");
  assert.equal(reply.inputId, "msg_1");
  assert.deepEqual(drafts, ["Dim", "Dimmed to", "Dimmed to 40%."]);
  assert.deepEqual(methodOf(server.peers[0], "session.send")[0].params, {
    sessionId: "sess_1",
    clientEventId: "msg_1",
    data: { text: "Too bright", billingTag: null },
  });
  // One read of the settled interaction and one of the Turn; no polling while it ran.
  assert.deepEqual(calls, [
    "GET /api/v1/org/users/user_1/sessions/sess_1/interactions/msg_1",
    "GET /api/v1/org/users/user_1/sessions/sess_1/turns/turn_1",
  ]);
});

test("a send whose answer was lost goes out again with the same clientEventId on the next connection", async () => {
  const server = await start({
    http: rest([]),
    respond: (message, peer, index) => {
      if (message.method !== "session.send") return undefined;
      if (index === 0) {
        peer.destroy();
        return "silent";
      }
      setTimeout(() => peer.send(finished("20")), 10);
      return { result: { interaction: receipt(), replayed: true } };
    },
  });
  const conn = await sessionOf(server).connect();
  const reply = await conn.send("Too bright", { clientEventId: "msg_1" });
  const [first] = methodOf(server.peers[0], "session.send");
  const [again] = methodOf(server.peers[1], "session.send");
  assert.equal(again.params.clientEventId, first.params.clientEventId);
  assert.equal(reply.text, "Dimmed to 40%.");
});

test("refusals, rejected messages, failed Turns and timeouts surface like turn()", async () => {
  let mode;
  const calls = [];
  const server = await start({
    http: (req, res) =>
      mode === "failed"
        ? rest(calls, settled({ result: { status: "failed", completedAt: done } }))(req, res)
        : rest(calls)(req, res),
    respond: (message, peer) => {
      if (message.method !== "session.send") return undefined;
      if (mode === "refused")
        return {
          error: {
            code: -32000,
            message: "The Session is read-only",
            data: { reason: "session_read_only", details: { since: at } },
          },
        };
      if (mode === "rejected")
        return {
          result: {
            interaction: receipt({ mode: "rejected", rejection: { code: "interaction_admission_closed" } }),
            replayed: false,
          },
        };
      if (mode === "failed") setTimeout(() => peer.send(finished("30")), 10);
      return { result: { interaction: receipt(), replayed: false } };
    },
  });
  const conn = await sessionOf(server).connect();
  mode = "refused";
  await assert.rejects(
    conn.send("x"),
    (error) =>
      error instanceof BackendRequestError &&
      error.reason === "session_read_only" &&
      error.details.since === at,
  );
  mode = "rejected";
  await assert.rejects(conn.send("x", { clientEventId: "msg_1" }), InputNotAppliedError);
  mode = "failed";
  await assert.rejects(conn.send("x", { clientEventId: "msg_1" }), TurnFailedError);
  mode = "running";
  await assert.rejects(
    conn.send("x", { clientEventId: "msg_1", timeoutMs: 50 }),
    (error) => error instanceof TurnWaitTimeoutError && error.inputId === "msg_1" && error.turnId === "turn_1",
  );
  for (const bad of [[[]], ["x", { clientEventId: "bad id" }], ["x", { unknown: 1 }], ["x", { onProgress: 1 }]])
    await assert.rejects(conn.send(...bad), TypeError);
});

test("a send after the connection ended is refused, and one cut off mid-send is uncertain", async () => {
  const server = await start({
    respond: (message, peer) => {
      if (message.method !== "session.send") return undefined;
      peer.send({ jsonrpc: "2.0", method: "session.detached", params: { sessionId: "sess_1", reason: "superseded" } });
      return "silent";
    },
  });
  const conn = await sessionOf(server).connect();
  await assert.rejects(
    conn.send("x", { clientEventId: "msg_1", timeoutMs: 5000 }),
    (error) => error instanceof OutcomeUnknownError && error.inputId === "msg_1",
  );
  await conn.closed;
  await assert.rejects(conn.send("x"), (error) => error instanceof TiDBLinkError && /superseded/.test(error.message));
});

test("a generated clientEventId is a UUID", async () => {
  const server = await start({
    respond: (message) =>
      message.method === "session.send"
        ? { error: { code: -32000, message: "Read-only", data: { reason: "session_read_only" } } }
        : undefined,
  });
  const conn = await sessionOf(server).connect();
  await assert.rejects(conn.send("x"), BackendRequestError);
  assert.match(methodOf(server.peers[0], "session.send")[0].params.clientEventId, /^[0-9a-f-]{36}$/);
});

test("realtimeGrant() opens the Realtime connection, or issues a token for a live one", async () => {
  const calls = [];
  let live = false;
  const grant = {
    websocketUrl: "wss://voice.example/realtime/ws",
    connectToken: "rct_" + "a".repeat(43),
    connectTokenExpiresAt: "2026-11-13T00:01:00.000Z",
  };
  const connection = {
    object: "realtime_connection",
    id: "rtc_1",
    sessionId: "sess_1",
    provider: { name: "qwen-omni", region: "cn-beijing", model: "qwen-live" },
    status: "connecting",
    audio: {
      input: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      output: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
    },
    activeTaskTurnId: null,
    usage: { inputAudioSec: 0, outputAudioSec: 0, thoughtTokens: 0, textTokens: 0 },
    metadata: {},
    createdAt: at,
    endedAt: null,
  };
  const server = await start({
    http: async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push([req.method, req.url, body]);
      if (req.url.endsWith("/realtime") && live)
        return json(res, { error: { code: "realtime_connection_live", message: "Live" } }, 409);
      if (req.url.endsWith("/realtime")) return json(res, { realtimeConnection: connection, ...grant }, 201);
      return json(res, { ...grant, connectToken: "rct_" + "b".repeat(43) }, 201);
    },
  });
  const conn = await sessionOf(server).connect();
  const audio = { input: { encoding: "pcm16", sampleRate: 16000, channels: 1 } };
  assert.deepEqual(await conn.realtimeGrant({ audio }), grant);
  live = true;
  assert.equal((await conn.realtimeGrant()).connectToken, "rct_" + "b".repeat(43));
  assert.deepEqual(calls, [
    ["POST", "/api/v1/org/users/user_1/sessions/sess_1/realtime", JSON.stringify({ audio })],
    ["POST", "/api/v1/org/users/user_1/sessions/sess_1/realtime", "{}"],
    ["POST", "/api/v1/org/users/user_1/sessions/sess_1/realtime/connect-tokens", ""],
  ]);
  await assert.rejects(conn.realtimeGrant({ voice: "x" }), TypeError);
});
