import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  OrganizationClient,
  StreamIdleError,
  TiDBLinkApiError,
  TiDBLinkError,
  asKnownSessionEvent,
  parseSessionEvent,
} from "../dist/index.js";

const servers = [];
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const apiKey = "ti_org_events_" + "x".repeat(43);
const sessionFor = (baseUrl) =>
  new OrganizationClient({ baseUrl, apiKey }).user("user_1").session("session_1");
const createdAt = "2026-11-11T00:00:00.000Z";
const turnData = (event, payload, turnId = "turn_1") => ({
  event,
  turnId,
  sessionId: "session_1",
  seq: 1,
  createdAt,
  payload,
});
const envelope = (type, data, turnId = "turn_1") => ({
  type,
  sessionId: "session_1",
  turnId,
  createdAt,
  data,
});
const sse = (cursor, value) => `id: ${cursor}\ndata: ${JSON.stringify(value)}\n\n`;
const streamHeaders = { "content-type": "text/event-stream" };
const toolCalls = (...ids) =>
  envelope(
    "agent.session.turn.requires_action",
    turnData("client_tool_calls", {
      calls: ids.map((callId) => ({
        callId,
        name: "lookup_order",
        arguments: { orderId: "order_1" },
        deadlineAt: "2099-01-01T00:00:00.000Z",
      })),
    }),
  );
const pending = (callId, deadlineAt = "2099-01-01T00:00:00.000Z") => ({
  callId,
  turnId: "turn_1",
  name: "lookup_order",
  arguments: { orderId: "order_1" },
  publishedAt: createdAt,
  deadlineAt,
});

const samples = {
  "agent.session.turn.started": turnData("turn_started", {
    inputId: "input_1",
    execution: { model: "model-a" },
  }),
  "agent.session.turn.output_text.snapshot": turnData("assistant_draft", {
    text: "Draft",
  }),
  "agent.session.turn.progress": turnData("progress", { text: "Searching" }),
  "agent.session.turn.item.added": turnData("assistant_message", {
    messageId: "message_1",
    text: "Done",
  }),
  "agent.session.turn.requires_action": toolCalls("call_1").data,
  "agent.session.turn.completed": turnData("turn_finished", {
    status: "succeeded",
  }),
  "agent.session.turn.cancelled": turnData("turn_finished", {
    status: "interrupted",
  }),
  "agent.session.turn.failed": turnData("turn_error", {
    code: "model_error",
    message: "The model failed",
  }),
  "agent.session.realtime.input_transcript.completed": {
    id: "rt_1",
    type: "input_transcript",
    realtimeConnectionId: "rtc_1",
    text: "Hello",
    turnId: null,
    createdAt,
  },
  "agent.session.realtime.response.completed": {
    id: "rt_2",
    type: "response",
    realtimeConnectionId: "rtc_1",
    text: "Hi",
    turnId: null,
    createdAt,
    kind: "chat",
    responseId: "resp_1",
    interrupted: false,
  },
  "agent.session.template_switch.succeeded": {
    id: "switch_1",
    commandId: "command_1",
    status: "succeeded",
    configurationEpoch: 2,
    agentTemplateId: "tmpl_2",
    contentDigest: "a".repeat(64),
    createdAt,
  },
};

test("every known event type parses into its typed form, and other events pass through", () => {
  for (const [type, data] of Object.entries(samples)) {
    const turnId = type.startsWith("agent.session.turn.") ? "turn_1" : null;
    const event = parseSessionEvent({
      id: `cursor-${type}`,
      data: JSON.stringify(envelope(type, data, turnId)),
    });
    assert.equal(event.cursor, `cursor-${type}`);
    assert.equal(asKnownSessionEvent(event)?.type, type, type);
  }
  const operation = parseSessionEvent({
    id: "c",
    data: JSON.stringify(
      envelope(
        "agent.session.turn.item.added",
        turnData("operation_step", {
          operationId: "op_1",
          status: "running",
          label: "lookup_order",
          source: { type: "session_client" },
        }),
      ),
    ),
  });
  assert(asKnownSessionEvent(operation));
  const finishedFailed = parseSessionEvent({
    id: "c",
    data: JSON.stringify(
      envelope("agent.session.turn.failed", turnData("turn_finished", { status: "failed" })),
    ),
  });
  assert(asKnownSessionEvent(finishedFailed));

  const future = parseSessionEvent({
    id: "c",
    data: JSON.stringify(envelope("agent.session.future.thing", { anything: 1 }, null)),
  });
  assert.equal(future.type, "agent.session.future.thing");
  assert.equal(asKnownSessionEvent(future), undefined);
  // A known type with a different shape is not narrowed.
  const mismatched = parseSessionEvent({
    id: "c",
    data: JSON.stringify(
      envelope("agent.session.turn.completed", turnData("turn_finished", { status: "failed" })),
    ),
  });
  assert.equal(asKnownSessionEvent(mismatched), undefined);
});

test("malformed frames are refused", () => {
  assert.throws(() => parseSessionEvent({ id: "c", data: "{" }), TiDBLinkError);
  assert.throws(
    () => parseSessionEvent({ id: "", data: JSON.stringify(envelope("x", {})) }),
    TiDBLinkError,
  );
  assert.throws(
    () =>
      parseSessionEvent(
        { id: "c", data: JSON.stringify(envelope("x", {})) },
        { sessionId: "other" },
      ),
    TiDBLinkError,
  );
});

test("a silent stream ends with StreamIdleError at the last cursor, while keep-alives and slow consumers do not", async () => {
  const baseUrl = await serve((request, response) => {
    response.writeHead(200, streamHeaders);
    response.write(sse("cursor-1", envelope("agent.session.turn.progress", samples["agent.session.turn.progress"])));
    if (request.url.includes("cursor=cursor-1")) {
      // Keep-alives only, then a second event and a normal end.
      const timer = setInterval(() => response.write(": keep-alive\n\n"), 40);
      setTimeout(() => {
        clearInterval(timer);
        response.end(sse("cursor-2", envelope("agent.session.turn.progress", samples["agent.session.turn.progress"])));
      }, 400);
    }
  });
  const session = sessionFor(baseUrl);
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const event of session.events({ idleTimeoutMs: 150 })) {
        seen.push(event.cursor);
        // Longer than the idle timeout: consumer time is not silence.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })(),
    (error) => {
      assert(error instanceof StreamIdleError);
      assert.equal(error.cursor, "cursor-1");
      assert.equal(error.idleTimeoutMs, 150);
      return true;
    },
  );
  assert.deepEqual(seen, ["cursor-1"]);
  const resumed = [];
  for await (const event of session.events({ cursor: "cursor-1", idleTimeoutMs: 150 }))
    resumed.push(event.cursor);
  assert.deepEqual(resumed, ["cursor-1", "cursor-2"]);
  await assert.rejects(async () => session.events({ idleTimeoutMs: -1 }).next(), TypeError);
});

test("subscribe reconnects from the cursor and delivers each pending call once", async () => {
  const controller = new AbortController();
  const connections = [];
  let pendingCalls = [pending("call_old_answered", createdAt)];
  const baseUrl = await serve((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.endsWith("/client-tool-calls")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ calls: pendingCalls }));
    }
    connections.push(url.searchParams.get("cursor"));
    response.writeHead(200, streamHeaders);
    if (connections.length === 1) {
      // Replayed history: a call that is no longer pending.
      response.write(sse("c1", toolCalls("call_replayed")));
      pendingCalls = [pending("call_a")];
      response.write(sse("c2", toolCalls("call_a")));
      // The connection drops.
      setTimeout(() => response.destroy(), 20);
    } else if (connections.length === 2) {
      pendingCalls = [pending("call_a"), pending("call_b")];
      response.write(sse("c3", toolCalls("call_a", "call_b")));
      response.end();
    } else {
      response.write(": keep-alive\n\n");
      controller.abort();
    }
  });
  const items = [];
  for await (const item of sessionFor(baseUrl).subscribe({
    signal: controller.signal,
    maxReconnectDelayMs: 10,
  })) {
    items.push(
      item.type === "event"
        ? `event ${item.event.cursor}`
        : item.type === "client_tool_call"
          ? `call ${item.call.callId}`
          : "disconnected",
    );
  }
  assert.deepEqual(items, [
    "event c1",
    "event c2",
    "call call_a",
    "disconnected",
    "event c3",
    "call call_b",
    "disconnected",
  ]);
  assert.deepEqual(connections, [null, "c2", "c3"]);
});

test("subscribe stops with the refusal when the credential is no longer accepted", async () => {
  let streams = 0;
  const baseUrl = await serve((request, response) => {
    if (request.url.endsWith("/client-tool-calls")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ calls: [] }));
    }
    streams += 1;
    response
      .writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: "authentication_required", message: "Revoked" } }));
  });
  await assert.rejects(
    (async () => {
      for await (const item of sessionFor(baseUrl).subscribe({ maxReconnectDelayMs: 1 })) void item;
    })(),
    (error) => error instanceof TiDBLinkApiError && error.status === 401,
  );
  assert.equal(streams, 1);
});
