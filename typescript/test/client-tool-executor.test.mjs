import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import {
  ClientToolResultRefusedError,
  OrganizationClient,
} from "../dist/index.js";
import { backendServer } from "./support/backend-server.mjs";

const apiKey = "ti_org_tools_" + "x".repeat(43);
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
const deadlineIn = (ms) => new Date(Date.now() + ms).toISOString();
const call = (callId, name = "set_light", args = { on: true }, deadlineMs = 60000) => ({
  jsonrpc: "2.0",
  method: "tool.call",
  params: {
    callId,
    sessionId: "sess_1",
    userId: "user_1",
    turnId: "turn_1",
    name,
    arguments: args,
    claimBy: deadlineIn(5000),
    deadlineAt: deadlineIn(deadlineMs),
  },
});
const granted = (message) =>
  message.method === "tool.claim" ? { result: { claimed: true } } : undefined;
const accepted = (message) =>
  message.method === "tool.result" ? { result: { accepted: true } } : undefined;
const byMethod = (peer, method) => peer.log.filter((message) => message.method === method);
const lamp = (runs, run) => ({
  set_light: {
    description: "Turn the lamp on or off",
    parameters: { type: "object", properties: { on: { type: "boolean" } } },
    run: async (args, context) => {
      runs.push({ args, context });
      return run ? run(args, context) : `Lamp ${args.on ? "on" : "off"}`;
    },
  },
});

test("a call runs only after its claim is granted, and its result goes back to the core", async () => {
  const order = [];
  const server = await start({
    respond: (message) => {
      if (message.method === "tool.claim") order.push("claim");
      if (message.method === "tool.result") order.push("result");
      return granted(message) ?? accepted(message);
    },
  });
  const runs = [];
  const conn = await sessionOf(server).connect({
    tools: lamp(runs, (args) => {
      order.push("run");
      return `Lamp ${args.on ? "on" : "off"}`;
    }),
  });
  const peer = server.peers[0];
  peer.send(call("call_1"));
  await until(() => byMethod(peer, "tool.result").length === 1);
  assert.deepEqual(order, ["claim", "run", "result"]);
  assert.deepEqual(byMethod(peer, "tool.claim")[0].params, { callId: "call_1" });
  assert.deepEqual(byMethod(peer, "tool.result")[0].params, { callId: "call_1", output: "Lamp on" });
  const { args, context } = runs[0];
  assert.deepEqual(args, { on: true });
  assert.equal(context.callId, "call_1");
  assert.equal(context.sessionId, "sess_1");
  assert.equal(context.userId, "user_1");
  assert.equal(context.turnId, "turn_1");
  assert.equal(context.name, "set_light");
  assert(context.deadlineAt instanceof Date);
  assert.equal(context.signal.aborted, false);
  await conn.close();
});

test("a refused claim never runs, duplicates run once, and a superseded claim may run after redelivery", async () => {
  let claims = 0;
  const server = await start({
    respond: (message) => {
      if (message.method !== "tool.claim") return accepted(message);
      claims += 1;
      if (message.params.callId === "late")
        return { result: { claimed: false, reason: "claim_window_closed" } };
      if (message.params.callId === "moved" && claims <= 2)
        return { result: { claimed: false, reason: "superseded" } };
      return { result: { claimed: true } };
    },
  });
  const runs = [];
  await sessionOf(server).connect({ tools: lamp(runs) });
  const peer = server.peers[0];
  peer.send(call("late"));
  await until(() => claims === 1);
  peer.send(call("late"));
  peer.send(call("moved"));
  await until(() => claims === 2);
  await delay(30);
  assert.equal(runs.length, 0);
  peer.send(call("moved"));
  await until(() => byMethod(peer, "tool.result").length === 1);
  peer.send(call("moved"));
  await delay(30);
  assert.equal(claims, 3);
  assert.deepEqual(runs.map((run) => run.context.callId), ["moved"]);
});

test("errors, values, missing handlers and deadlines become results the model can read", async () => {
  const server = await start({ respond: (message) => granted(message) ?? accepted(message) });
  let aborted;
  const tools = {
    fail: { description: "Fails", parameters: {}, run: () => { throw new Error("Lamp offline"); } },
    status: { description: "Status", parameters: {}, run: () => ({ on: true, brightness: 40 }) },
    nothing: { description: "Nothing", parameters: {}, run: () => undefined },
    huge: { description: "Huge", parameters: {}, run: () => "x".repeat(65537) },
    hang: {
      description: "Hangs",
      parameters: {},
      run: (_, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener("abort", () => {
            aborted = context.signal.reason;
            resolve("too late");
          });
        }),
    },
  };
  await sessionOf(server).connect({ tools });
  const peer = server.peers[0];
  peer.send(call("c_fail", "fail", {}));
  peer.send(call("c_status", "status", {}));
  peer.send(call("c_nothing", "nothing", {}));
  peer.send(call("c_huge", "huge", {}));
  peer.send(call("c_unknown", "unknown_tool", {}));
  peer.send(call("c_hang", "hang", {}, 300));
  await until(() => byMethod(peer, "tool.result").length === 6);
  const results = Object.fromEntries(
    byMethod(peer, "tool.result").map(({ params: { callId, ...rest } }) => [callId, rest]),
  );
  assert.deepEqual(results.c_fail, { error: { message: "Lamp offline" } });
  assert.deepEqual(results.c_status, { output: '{"on":true,"brightness":40}' });
  assert.deepEqual(results.c_nothing, { output: "" });
  assert.match(results.c_huge.error.message, /exceeds 65536 characters/);
  assert.match(results.c_unknown.error.message, /unknown_tool has no handler/);
  assert.match(results.c_hang.error.message, /deadline/);
  assert.match(aborted.message, /deadline/);
});

test("a lost claim answer closes the call as failed without running it", async () => {
  const server = await start({
    respond: (message, peer, index) => {
      if (message.method === "tool.claim" && index === 0) {
        peer.destroy();
        return "silent";
      }
      return accepted(message);
    },
  });
  const runs = [];
  await sessionOf(server).connect({ tools: lamp(runs) });
  server.peers[0].send(call("call_1"));
  const next = await server.connection(1);
  await until(() => byMethod(next, "tool.result").length === 1);
  assert.equal(runs.length, 0);
  assert.equal(byMethod(next, "tool.result")[0].params.callId, "call_1");
  assert.match(byMethod(next, "tool.result")[0].params.error.message, /did not execute/);
});

test("a result survives a lost connection, and a refused one reaches onError", async () => {
  let results = 0;
  const server = await start({
    respond: (message, peer) => {
      if (message.method !== "tool.result") return granted(message);
      results += 1;
      if (results === 1) {
        peer.destroy();
        return "silent";
      }
      return message.params.callId === "settled"
        ? { result: { accepted: false, reason: "call_settled" } }
        : { result: { accepted: true } };
    },
  });
  const runs = [];
  const errors = [];
  await sessionOf(server).connect({ tools: lamp(runs), onError: (error) => errors.push(error) });
  server.peers[0].send(call("call_1"));
  const next = await server.connection(1);
  await until(() => byMethod(next, "tool.result").length === 1);
  assert.deepEqual(byMethod(next, "tool.result")[0].params, { callId: "call_1", output: "Lamp on" });
  assert.equal(runs.length, 1);
  await until(() => byMethod(next, "session.attach").length === 1);
  next.send(call("settled"));
  await until(() => errors.length === 1);
  assert(errors[0] instanceof ClientToolResultRefusedError);
  assert.equal(errors[0].callId, "settled");
  assert.equal(errors[0].reason, "call_settled");
});

test("an observing connection never claims calls", async () => {
  const server = await start();
  await sessionOf(server).connect({ observe: true });
  const peer = server.peers[0];
  peer.send(call("call_1"));
  await delay(50);
  assert.equal(byMethod(peer, "tool.claim").length, 0);
});
