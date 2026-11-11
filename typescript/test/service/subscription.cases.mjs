import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient, asKnownSessionEvent } from "@tidblink/server";
import {
  connectDevice,
  serveDeviceTools,
} from "@tidblink/server/examples/device-voice-session.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const organizationApiKey = process.env.SDK_ORGANIZATION_KEY;
const userId = process.env.SDK_USER_ID;
assert(baseUrl && organizationApiKey && userId, "Run this suite through npm run test:service");
const user = new OrganizationClient({ baseUrl, apiKey: organizationApiKey }).user(userId);
const tool = {
  type: "function",
  name: "lookup_order",
  description: "Look up an application order",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
};
const freshSession = async () =>
  (
    await user.createAgent({
      agentTemplateId: process.env.SDK_TEMPLATE_ID,
      idempotencyKey: randomUUID(),
    })
  ).createSession({ idempotencyKey: randomUUID(), tools: [tool] });
const until = async (condition, label) => {
  const end = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A transport that breaks the first event stream right after its first event. */
const droppingFetch = () => {
  let dropped = false;
  return async (input, init) => {
    const response = await fetch(input, init);
    if (dropped || !String(input).includes("/events?stream=true")) return response;
    dropped = true;
    const reader = response.body.getReader();
    let text = "";
    const decoder = new TextDecoder();
    const body = new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        controller.enqueue(chunk.value);
        text += decoder.decode(chunk.value, { stream: true });
        if (/(^|\n)data:.*\n\n/s.test(text)) {
          await reader.cancel();
          controller.error(new TypeError("terminated"));
        }
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
};

test("two subscriptions each receive a text-initiated Client Tool call once, across a dropped connection", async () => {
  const session = await freshSession();
  const subscriptions = [
    new OrganizationClient({ baseUrl, apiKey: organizationApiKey, fetch: droppingFetch() }),
    new OrganizationClient({ baseUrl, apiKey: organizationApiKey }),
  ].map((client) => {
    const controller = new AbortController();
    const seen = { calls: [], events: [], disconnects: 0, controller };
    seen.done = (async () => {
      for await (const item of client
        .user(userId)
        .session(session.id)
        .subscribe({ signal: controller.signal, maxReconnectDelayMs: 200 })) {
        if (item.type === "client_tool_call") seen.calls.push(item.call);
        else if (item.type === "event") seen.events.push(item.event);
        else seen.disconnects += 1;
      }
    })();
    return seen;
  });
  const [dropping, steady] = subscriptions;

  const message = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_CLIENT_TOOL",
  });
  await until(() => dropping.calls.length && steady.calls.length, "both subscriptions to receive the call");
  const [call] = steady.calls;
  assert.equal(call.turnId, message.turnId);
  assert.equal(call.name, "lookup_order");
  await session.submitClientToolOutput({
    clientEventId: randomUUID(),
    turnId: call.turnId,
    callId: call.callId,
    output: "SDK_SUBSCRIPTION_OUTPUT",
  });
  const result = await session.waitForResult(message.inputId);
  assert.match(result.text, /SDK_SUBSCRIPTION_OUTPUT/);
  await until(
    () => subscriptions.every((s) => s.events.some((e) => e.type === "agent.session.turn.completed")),
    "both subscriptions to see the Turn complete",
  );
  for (const seen of subscriptions) {
    seen.controller.abort();
    await seen.done;
    assert.deepEqual(seen.calls.map((c) => c.callId), [call.callId]);
    // Every Turn event the real service sent has the shape the SDK types.
    const turnEvents = seen.events.filter((e) => e.type.startsWith("agent.session.turn."));
    assert(turnEvents.length >= 4);
    for (const event of turnEvents)
      assert.equal(asKnownSessionEvent(event)?.type, event.type, JSON.stringify(event));
    const cursors = seen.events.map((e) => e.cursor);
    assert.equal(new Set(cursors).size, cursors.length, "no event is delivered twice");
  }
  assert(dropping.disconnects >= 1, "the dropped connection was reported");
  assert(
    dropping.events.some((e) => e.type === "agent.session.turn.requires_action"),
  );
});

test("the device voice session example connects a device and answers its tools on the text path", async () => {
  const session = await freshSession();
  const options = { baseUrl, organizationApiKey, userId, sessionId: session.id };
  const grant = await connectDevice({ ...options, metadata: { terminal: "sdk-device" } });
  assert.match(grant.connectToken, /^rct_/u);
  assert.match(grant.websocketUrl, /^wss?:\/\//u);
  const again = await connectDevice(options);
  assert.notEqual(again.connectToken, grant.connectToken);

  const controller = new AbortController();
  const executed = [];
  let cursor;
  const serving = serveDeviceTools({
    ...options,
    signal: controller.signal,
    saveCursor: (value) => {
      cursor = value;
    },
    executeOnDevice: async (call) => {
      executed.push(call.callId);
      return "SDK_DEVICE_OUTPUT";
    },
  });
  try {
    const message = await session.submitMessage({
      clientEventId: randomUUID(),
      text: "SDK_FIXTURE_CLIENT_TOOL",
    });
    const result = await session.waitForResult(message.inputId);
    assert.match(result.text, /SDK_DEVICE_OUTPUT/);
    assert.equal(executed.length, 1);
    await until(() => cursor !== undefined, "a saved cursor");
  } finally {
    controller.abort();
    await serving;
    await session.endRealtimeConnection();
  }
});
