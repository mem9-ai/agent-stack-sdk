import assert from "node:assert/strict";
import { test } from "node:test";
import { asKnownSessionEvent } from "../dist/index.js";

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
  "agent.session.idle": { id: "idle_1", turnId: "turn_1", createdAt },
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

const withCursor = (cursor, value) => ({ ...value, cursor });

test("every known event type narrows to its typed form, and other events pass through", () => {
  for (const [type, data] of Object.entries(samples)) {
    const turnId = type.startsWith("agent.session.turn.") ? "turn_1" : null;
    const event = withCursor(`cursor-${type}`, envelope(type, data, turnId));
    assert.equal(asKnownSessionEvent(event)?.type, type, type);
  }
  const operation = withCursor(
    "c",
    envelope(
      "agent.session.turn.item.added",
      turnData("operation_step", {
        operationId: "op_1",
        status: "running",
        label: "lookup_order",
        source: { type: "session_client" },
      }),
    ),
  );
  assert(asKnownSessionEvent(operation));
  const finishedFailed = withCursor(
    "c",
    envelope("agent.session.turn.failed", turnData("turn_finished", { status: "failed" })),
  );
  assert(asKnownSessionEvent(finishedFailed));
  const future = withCursor("c", envelope("agent.session.future.thing", { anything: 1 }, null));
  assert.equal(asKnownSessionEvent(future), undefined);
  // A known type with a different shape is not narrowed.
  const mismatched = withCursor(
    "c",
    envelope("agent.session.turn.completed", turnData("turn_finished", { status: "failed" })),
  );
  assert.equal(asKnownSessionEvent(mismatched), undefined);
  const idleWithoutTurn = withCursor(
    "c",
    envelope("agent.session.idle", { id: "idle_2", turnId: null, createdAt }, null),
  );
  assert.equal(asKnownSessionEvent(idleWithoutTurn)?.type, "agent.session.idle");
});
