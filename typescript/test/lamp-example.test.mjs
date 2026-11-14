import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { createLampBackend, memoryStore } from "../examples/lamp-backend.mjs";
import { backendServer } from "./support/backend-server.mjs";

const apiKey = "ti_org_lamp_" + "x".repeat(43);
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
const idle = (cursor, turnId = "turn_1") => ({
  jsonrpc: "2.0",
  method: "session.event",
  params: {
    sessionId: "sess_1",
    cursor,
    event: {
      type: "agent.session.idle",
      sessionId: "sess_1",
      turnId,
      createdAt: done,
      data: { id: `idle_${cursor}`, turnId, createdAt: done },
    },
  },
});
const methodOf = (peer, method) => peer.log.filter((m) => m.method === method);


const grant = {
  websocketUrl: "wss://voice.example/realtime/ws",
  connectToken: "rct_" + "a".repeat(43),
  connectTokenExpiresAt: "2026-11-13T00:01:00.000Z",
};
const lampServer = (respond) =>
  start({
    respond,
    http: async (req, res) => {
      for await (const _ of req) {
      }
      if (req.url.endsWith("/realtime"))
        return json(res, { error: { code: "realtime_connection_live", message: "Live" } }, 409);
      if (req.url.endsWith("/connect-tokens")) return json(res, grant, 201);
      return rest([])(req, res);
    },
  });
const fakeLamps = (onlineIds) => {
  const requests = [];
  const sent = [];
  return {
    requests,
    sent,
    isOnline: (id) => onlineIds.has(id),
    request: async (id, command, args) => {
      requests.push([id, command, args]);
      return { on: true, brightness: args.brightness ?? 100, colorTemp: 4000 };
    },
    send: (id, topic, payload) => sent.push([id, topic, payload]),
  };
};
const boundStore = async () => {
  const store = memoryStore();
  await store.bind("lamp-1", { userId: "user_1", sessionId: "sess_1" });
  await store.saveCursor("lamp-1", "7");
  return store;
};
const toolCall = (callId, name, args) => ({
  jsonrpc: "2.0",
  method: "tool.call",
  params: {
    callId,
    sessionId: "sess_1",
    userId: "user_1",
    turnId: "turn_1",
    name,
    arguments: args,
    claimBy: new Date(Date.now() + 5000).toISOString(),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  },
});
const backends = [];
after(() => Promise.all(backends.map((backend) => backend.close())));
const lampBackend = async (server, device, store) => {
  const backend = createLampBackend({
    baseUrl: server.baseUrl,
    organizationApiKey: apiKey,
    templateId: "template_lamp",
    device,
    store: store ?? (await boundStore()),
  });
  backends.push(backend);
  return backend;
};

test("an online lamp's Session declares the lamp's tools and forwards their calls to the lamp", async () => {
  const server = await lampServer((message) =>
    message.method === "tool.claim"
      ? { result: { claimed: true } }
      : message.method === "tool.result"
        ? { result: { accepted: true } }
        : undefined,
  );
  const device = fakeLamps(new Set(["lamp-1"]));
  const backend = await lampBackend(server, device);
  await backend.onDeviceOnline("lamp-1");
  const peer = server.peers[0];
  const attach = methodOf(peer, "session.attach")[0].params;
  assert.equal(attach.cursor, "7");
  assert.deepEqual(attach.tools.map((tool) => tool.name), ["set_light", "get_status", "set_timer"]);
  peer.send(toolCall("call_1", "set_light", { brightness: 40 }));
  await until(() => methodOf(peer, "tool.result").length === 1);
  assert.deepEqual(device.requests, [["lamp-1", "set_light", { brightness: 40 }]]);
  assert.deepEqual(methodOf(peer, "tool.result")[0].params, {
    callId: "call_1",
    output: "The lamp is on at 40% and 4000 K",
  });
  // The lamp drops off the device channel: its tools fail at once.
  device.isOnline = () => false;
  peer.send(toolCall("call_2", "get_status", {}));
  await until(() => methodOf(peer, "tool.result").length === 2);
  assert.deepEqual(methodOf(peer, "tool.result")[1].params, {
    callId: "call_2",
    error: { message: "The lamp is offline" },
  });
  await backend.onDeviceOffline("lamp-1");
  assert.equal(methodOf(peer, "session.detach").length, 1);
});

test("typing while the lamp is offline uses a temporary connection; talking hands the lamp a voice grant", async () => {
  const server = await lampServer((message, peer) => {
    if (message.method !== "session.send") return undefined;
    setTimeout(() => {
      peer.send(finished("20"));
      peer.send(idle("21"));
    }, 10);
    return { result: { interaction: receipt(), replayed: false } };
  });
  const device = fakeLamps(new Set());
  const backend = await lampBackend(server, device);
  assert.equal(
    await backend.onAppMessage("lamp-1", "Too bright", { clientEventId: "msg_1" }),
    "Dimmed to 40%.",
  );
  const peer = server.peers[0];
  assert.deepEqual(
    peer.log.map((message) => message.method),
    ["session.attach", "session.send", "session.detach"],
  );
  await assert.rejects(backend.onDeviceWantsToTalk("lamp-1"), /not online/);
  await backend.onDeviceOnline("lamp-1");
  assert.deepEqual(await backend.onDeviceWantsToTalk("lamp-1"), grant);
  assert.deepEqual(device.sent, [["lamp-1", "voice_grant", grant]]);
});

test("a lamp that another process took over is no longer online here", async () => {
  const server = await lampServer();
  const backend = await lampBackend(server, fakeLamps(new Set(["lamp-1"])));
  await backend.onDeviceOnline("lamp-1");
  server.peers[0].send({
    jsonrpc: "2.0",
    method: "session.detached",
    params: { sessionId: "sess_1", reason: "superseded" },
  });
  await delay(50);
  await assert.rejects(backend.onDeviceWantsToTalk("lamp-1"), /not online/);
  await assert.rejects(backend.onDeviceOnline("lamp-unbound"), /not bound/);
});
