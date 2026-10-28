import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { UserClient } from "../dist/index.js";

const userApiKey = "ti_user_key_" + "x".repeat(43);
const createdAt = "2026-10-28T00:00:00.000Z";
const turn = {
  id: "turn_1",
  sessionId: "session/1",
  executor: "full_agent",
  status: "succeeded",
  billingTag: null,
  operations: [],
  createdAt,
  completedAt: createdAt,
  userMessage: {
    id: "msg_1",
    sessionId: "session/1",
    turnId: "turn_1",
    role: "user",
    content: "Hello",
    createdAt,
    inputContext: { channel: "text" },
  },
  assistantMessage: {
    id: "msg_2",
    sessionId: "session/1",
    turnId: "turn_1",
    role: "assistant",
    content: "Hi",
    createdAt,
  },
};
const interaction = {
  inputId: "command/1",
  sequence: 1,
  kind: "message",
  mode: "started",
  turnId: "turn_1",
  message: { id: "msg_1", role: "user", content: "Hello", createdAt },
  createdAt,
  appliedAt: createdAt,
  rejection: null,
  result: { status: "succeeded", completedAt: createdAt },
};
const serve = async (context, handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return new UserClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: userApiKey,
  }).session("session/1");
};

test("history preserves Turn pages and selected Full Agent details", async (context) => {
  const calls = [];
  const page = { turns: [turn], hasMore: true, nextCursor: "opaque+/=" };
  const session = await serve(context, (req, res) => {
    calls.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.endsWith("/turn_1") ? { turn } : page));
  });
  assert.deepEqual(
    await session.history({ limit: 1, cursor: "opaque+/=" }),
    page,
  );
  assert.deepEqual(await session.getTurn("turn_1"), turn);
  assert.deepEqual(calls, [
    "/api/v1/user/sessions/session%2F1/turns?limit=1&cursor=opaque%2B%2F%3D",
    "/api/v1/user/sessions/session%2F1/turns/turn_1",
  ]);
});

test("interaction pagination and exact command reconciliation preserve durable original receipts", async (context) => {
  const calls = [];
  const page = {
    interactions: [interaction],
    hasMore: true,
    nextCursor: "interaction-cursor",
  };
  const session = await serve(context, (req, res) => {
    calls.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.includes("clientEventId=missing"))
      res.end(
        JSON.stringify({ interactions: [], hasMore: false, nextCursor: null }),
      );
    else if (req.url.includes("clientEventId="))
      res.end(
        JSON.stringify({
          interactions: [interaction],
          hasMore: false,
          nextCursor: null,
        }),
      );
    else if (req.url.endsWith("command%2F1"))
      res.end(JSON.stringify({ interaction }));
    else res.end(JSON.stringify(page));
  });
  assert.deepEqual(
    await session.listInteractions({ limit: 1, cursor: "interaction-cursor" }),
    page,
  );
  assert.deepEqual(await session.getInteraction("command/1"), interaction);
  assert.deepEqual(
    await session.reconcileInteraction("command/1"),
    interaction,
  );
  assert.equal(await session.reconcileInteraction("missing"), null);
  assert.deepEqual(calls, [
    "/api/v1/user/sessions/session%2F1/interactions?limit=1&cursor=interaction-cursor",
    "/api/v1/user/sessions/session%2F1/interactions/command%2F1",
    "/api/v1/user/sessions/session%2F1/interactions?clientEventId=command%2F1",
    "/api/v1/user/sessions/session%2F1/interactions?clientEventId=missing",
  ]);
});

test("mixed history and timeline preserve Realtime projections and opaque continuation", async (context) => {
  const realtime = {
    ...turn,
    id: "turn_rt_1",
    executor: "realtime_model",
    userMessage: {
      ...turn.userMessage,
      turnId: "turn_rt_1",
      inputContext: { channel: "audio" },
      realtime: { startsTurn: true, linkedTurnId: "turn_1" },
    },
    userMessages: [
      {
        ...turn.userMessage,
        turnId: "turn_rt_1",
        inputContext: { channel: "audio" },
        realtime: { startsTurn: true, linkedTurnId: "turn_1" },
      },
    ],
    realtime: { connectionId: "rtc_1", linkedTurnIds: ["turn_1"] },
    assistantMessage: {
      ...turn.assistantMessage,
      turnId: "turn_rt_1",
      realtime: {
        kind: "task_result",
        interrupted: true,
        responseId: "response_1",
        linkedTurnId: "turn_1",
      },
    },
  };
  const fact = {
    id: "rt_1",
    type: "response",
    realtimeConnectionId: "rtc_1",
    text: "Hi",
    turnId: "turn_1",
    responseId: "response_1",
    kind: "task_result",
    interrupted: true,
    createdAt,
  };
  const historyPage = {
    turns: [turn, realtime],
    hasMore: false,
    nextCursor: null,
  };
  const timelinePage = {
    entries: [
      { type: "turn", turn },
      { type: "realtime", realtime: fact },
    ],
    hasMore: true,
    nextCursor: "timeline+/=",
  };
  const calls = [];
  const session = await serve(context, (req, res) => {
    calls.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url.includes("/timeline") ? timelinePage : historyPage,
      ),
    );
  });
  assert.deepEqual(await session.history(), historyPage);
  assert.deepEqual(
    await session.timeline({ limit: 2, cursor: "timeline+/=" }),
    timelinePage,
  );
  assert.deepEqual(calls, [
    "/api/v1/user/sessions/session%2F1/turns",
    "/api/v1/user/sessions/session%2F1/timeline?limit=2&cursor=timeline%2B%2F%3D",
  ]);
});

test("receipt reads reject mismatched or unusable identities instead of returning another command outcome", async (context) => {
  let body = { interaction: { ...interaction, inputId: "other-command" } };
  const session = await serve(context, (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await assert.rejects(
    session.getInteraction("command/1"),
    /invalid interaction receipt/,
  );
  body = {
    interactions: [{ ...interaction, inputId: "other-command" }],
    hasMore: false,
    nextCursor: null,
  };
  await assert.rejects(
    session.reconcileInteraction("command/1"),
    /invalid interaction receipt/,
  );
  body = { interactions: null };
  await assert.rejects(
    session.reconcileInteraction("command/1"),
    /invalid interaction lookup/,
  );
  body = {
    interaction: {
      ...interaction,
      result: { status: "accepted", completedAt: null },
    },
  };
  await assert.rejects(
    session.getInteraction("command/1"),
    /invalid interaction receipt/,
  );
  body = { turn: { ...turn, sessionId: "another-session" } };
  await assert.rejects(session.getTurn("turn_1"), /different Turn/);
});

test("unavailable history and foreign cursor refusals retain service code and request identity", async (context) => {
  const session = await serve(context, (req, res) => {
    res.writeHead(req.url.includes("cursor=") ? 400 : 404, {
      "content-type": "application/json",
      "x-request-id": "service-history",
    });
    res.end(
      JSON.stringify({
        error: {
          code: req.url.includes("cursor=")
            ? "validation_error"
            : "session_not_found",
          message: "Unavailable",
        },
      }),
    );
  });
  await assert.rejects(
    session.history({ cursor: "foreign" }),
    (error) =>
      error.status === 400 &&
      error.code === "validation_error" &&
      error.requestId === "service-history",
  );
  await assert.rejects(
    session.timeline(),
    (error) => error.status === 404 && error.code === "session_not_found",
  );
});
