import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  BackendRequestError,
  OrganizationClient,
  TurnFailedError,
  TurnInterruptedError,
  TurnWaitTimeoutError,
} from "@tidblink/server";

const baseUrl = process.env.SDK_SERVICE_URL;
const apiKey = process.env.SDK_ORGANIZATION_KEY;
const client = () => new OrganizationClient({ baseUrl, apiKey });
const until = async (predicate, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(25);
  }
};
const lookupOrder = (runs, result) => ({
  lookup_order: {
    description: "Look up an application order",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
      additionalProperties: false,
    },
    run: async (args, context) => {
      runs.push({ args, context });
      if (result instanceof Error) throw result;
      return result;
    },
  },
});
const freshSession = (org) =>
  org.user(process.env.SDK_USER_ID).createSession({
    templateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });

for (const outcome of ["success", "failure"])
  test(`a connected Application Server claims and answers the real Runtime's Client Tool call (${outcome})`, async () => {
    const org = client();
    try {
      const session = await freshSession(org);
      const runs = [];
      const events = [];
      const cursors = [];
      const literal =
        outcome === "success" ? "SDK_BACKEND_ORDER_SHIPPED" : "SDK_BACKEND_ORDER_UNAVAILABLE";
      const conn = await org
        .user(process.env.SDK_USER_ID)
        .session(session.id)
        .connect({
          tools: lookupOrder(runs, outcome === "success" ? literal : new Error(literal)),
          onEvent: (event) => events.push(event),
          onCursor: (cursor) => cursors.push(cursor),
        });
      // The attach declared the Session's Client Tools.
      assert.deepEqual(
        (await session.getClientTools()).tools.map((tool) => tool.name),
        ["lookup_order"],
      );
      const message = await session.submitMessage({
        clientEventId: randomUUID(),
        text: "SDK_FIXTURE_CLIENT_TOOL",
      });
      const answer = await session.waitForResult(message.inputId, {
        timeoutMs: 20000,
        pollIntervalMs: 25,
      });
      assert(answer.text.includes(literal), answer.text);
      assert.equal(runs.length, 1);
      assert.deepEqual(runs[0].args, { orderId: "order_1" });
      assert.equal(runs[0].context.turnId, message.turnId);
      assert.equal(runs[0].context.sessionId, session.id);
      assert.equal(runs[0].context.userId, process.env.SDK_USER_ID);
      await until(() => events.some((event) => event.type === "agent.session.turn.completed"));
      const types = events.map((event) => event.type);
      assert.equal(types[0], "agent.session.turn.started");
      assert(types.includes("agent.session.turn.requires_action"));
      const requires = events.find((event) => event.type === "agent.session.turn.requires_action");
      assert(requires.data.payload.calls[0].claimBy, "calls on an executing attachment carry claimBy");
      // Events arrive in order, and the saved cursor follows them.
      assert.deepEqual(cursors, events.map((event) => event.cursor));
      assert.equal(conn.cursor, cursors.at(-1));
      await conn.close();
      assert.deepEqual(await conn.closed, { reason: "closed" });
    } finally {
      await org.close();
    }
  });

test("resuming with a cursor replays the events after it, and another process's connection supersedes this one", async () => {
  const first = client();
  const second = client();
  try {
    const session = await freshSession(first);
    const user = first.user(process.env.SDK_USER_ID);
    const runs = [];
    const conn = await user.session(session.id).connect({ tools: lookupOrder(runs, "ok") });
    const start = conn.cursor;
    const message = await session.submitMessage({
      clientEventId: randomUUID(),
      text: "SDK_FIXTURE_CLIENT_TOOL",
    });
    await session.waitForResult(message.inputId, { timeoutMs: 20000, pollIntervalMs: 25 });
    await until(() => conn.cursor !== start);
    await conn.close();

    const replayed = [];
    const resumed = await second
      .user(process.env.SDK_USER_ID)
      .session(session.id)
      .connect({ cursor: start, observe: true, onEvent: (event) => replayed.push(event) });
    await until(() => replayed.some((event) => event.type === "agent.session.turn.completed"));
    assert.equal(replayed[0].type, "agent.session.turn.started");
    assert.equal(replayed[0].turnId, message.turnId);
    await resumed.close();

    const executing = await user.session(session.id).connect({ tools: lookupOrder(runs, "ok") });
    const taker = await second.user(process.env.SDK_USER_ID).session(session.id).connect();
    assert.deepEqual(await executing.closed, { reason: "superseded" });
    assert(taker.generation > executing.generation);
    await taker.close();
  } finally {
    await first.close();
    await second.close();
  }
});

test("attaching another End User's Session is refused", async () => {
  const org = client();
  try {
    const session = await freshSession(org);
    await assert.rejects(
      org.user(process.env.SDK_FOREIGN_USER_ID).session(session.id).connect(),
      (error) => error instanceof BackendRequestError && error.reason === "session_not_found",
    );
  } finally {
    await org.close();
  }
});

test("send() starts a Turn over the connection and returns its answer; the tool runs in between", async () => {
  const org = client();
  try {
    const session = await freshSession(org);
    const runs = [];
    const conn = await org
      .user(process.env.SDK_USER_ID)
      .session(session.id)
      .connect({ tools: lookupOrder(runs, "SDK_SEND_ORDER_SHIPPED") });
    const clientEventId = randomUUID();
    const reply = await conn.send("SDK_FIXTURE_CLIENT_TOOL", { clientEventId, timeoutMs: 20000 });
    assert.equal(reply.type, "answer");
    assert(reply.text.includes("SDK_SEND_ORDER_SHIPPED"), reply.text);
    assert.equal(reply.inputId, clientEventId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].context.turnId, reply.turnId);
    // The same clientEventId is the REST command identity.
    assert.equal((await session.getInteraction(clientEventId)).turnId, reply.turnId);
    const again = await conn.send("SDK_FIXTURE_CLIENT_TOOL", { clientEventId, timeoutMs: 20000 });
    assert.equal(again.turnId, reply.turnId);
    assert.equal(runs.length, 1);
    await conn.close();
  } finally {
    await org.close();
  }
});

test("realtimeGrant() prepares the Session's Realtime connection, then reissues a token for it", async () => {
  const org = client();
  try {
    const session = await freshSession(org);
    const conn = await org.user(process.env.SDK_USER_ID).session(session.id).connect({ observe: true });
    const first = await conn.realtimeGrant({ metadata: { device: "sdk-lamp" } });
    assert.match(first.connectToken, /^rct_/u);
    assert.match(first.websocketUrl, /\/realtime\/ws$/u);
    const second = await conn.realtimeGrant();
    assert.match(second.connectToken, /^rct_/u);
    assert.notEqual(second.connectToken, first.connectToken);
    await session.endRealtimeConnection();
    await conn.close();
  } finally {
    await org.close();
  }
});

test("the packaged lamp backend binds a lamp, answers typed messages and hands the lamp a voice grant", async () => {
  const { createLampBackend } = await import("@tidblink/server/examples/lamp-backend.mjs");
  const sent = [];
  const lamps = createLampBackend({
    baseUrl,
    organizationApiKey: apiKey,
    templateId: process.env.SDK_TEMPLATE_ID,
    device: {
      isOnline: () => true,
      request: async () => ({ on: true, brightness: 40, colorTemp: 4000 }),
      send: (deviceId, topic, payload) => sent.push([deviceId, topic, payload]),
    },
  });
  try {
    const deviceId = `lamp-${randomUUID()}`;
    const sessionId = await lamps.bindDevice(`app-user-${randomUUID()}`, deviceId);
    assert.match(sessionId, /^sess_/u);
    // Offline: a temporary connection carries the message.
    assert.equal(await lamps.onAppMessage(deviceId, "SDK_FIXTURE offline question"), "SDK final answer.");
    await lamps.onDeviceOnline(deviceId);
    const drafts = [];
    assert.equal(
      await lamps.onAppMessage(deviceId, "SDK_FIXTURE online question", { onDraft: (d) => drafts.push(d) }),
      "SDK final answer.",
    );
    const grant = await lamps.onDeviceWantsToTalk(deviceId);
    assert.match(grant.connectToken, /^rct_/u);
    assert.deepEqual(sent, [[deviceId, "voice_grant", grant]]);
    await lamps.onDeviceOffline(deviceId);
  } finally {
    await lamps.close();
  }
});

/** A connected Session for one case, closed with its client. */
const connected = async (options = {}) => {
  const org = client();
  const session = await freshSession(org);
  const conn = await org.user(process.env.SDK_USER_ID).session(session.id).connect(options);
  return { org, session, conn };
};

test("send() reports the growing draft from pushed events and replaces it with the final answer", async () => {
  const { org, session, conn } = await connected();
  try {
    const drafts = [];
    const reply = await conn.send("SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE", {
      onProgress: (draft) => drafts.push(draft),
      timeoutMs: 20000,
    });
    assert(drafts.includes("SDK draft."), JSON.stringify(drafts));
    assert(drafts.indexOf("SDK revised draft.") > drafts.indexOf("SDK draft."), JSON.stringify(drafts));
    assert.equal(reply.text, "SDK final answer.");
    // send() returned after the release: the next message starts a new Turn at once.
    await session.refresh();
    assert.equal(session.data.activeTurnId, null);
    const next = await conn.send("SDK_FIXTURE next", { timeoutMs: 20000 });
    assert.notEqual(next.turnId, reply.turnId);
    assert.equal(next.interaction.mode, "started");
  } finally {
    await org.close();
  }
});

test("send() keeps a failed Turn's drafts provisional and raises TurnFailedError", async () => {
  const { org, session, conn } = await connected();
  try {
    const drafts = [];
    const clientEventId = randomUUID();
    await assert.rejects(
      conn.send("SDK_FIXTURE_PROGRESS SDK_FIXTURE_FAIL", {
        clientEventId,
        onProgress: (draft) => drafts.push(draft),
        timeoutMs: 20000,
      }),
      (error) => error instanceof TurnFailedError && error.inputId === clientEventId,
    );
    assert(drafts.length > 0);
    assert.equal((await session.getInteraction(clientEventId)).result.status, "failed");
  } finally {
    await org.close();
  }
});

test("a local send() timeout keeps the message's identity and does not cancel the Turn", async () => {
  const { org, session, conn } = await connected();
  try {
    const clientEventId = randomUUID();
    await assert.rejects(
      conn.send("SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE", { clientEventId, timeoutMs: 200 }),
      (error) => error instanceof TurnWaitTimeoutError && error.inputId === clientEventId,
    );
    const result = await session.waitForResult(clientEventId, { timeoutMs: 20000, pollIntervalMs: 25 });
    assert.equal(result.text, "SDK final answer.");
    assert.equal((await session.listInteractions()).interactions.length, 1);
  } finally {
    await org.close();
  }
});

test("cancelling the Turn while send() waits raises TurnInterruptedError", async () => {
  const { org, session, conn } = await connected();
  try {
    const clientEventId = randomUUID();
    let cancelled;
    await assert.rejects(
      conn.send("SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE", {
        clientEventId,
        timeoutMs: 20000,
        onProgress: () => {
          cancelled ??= session
            .getInteraction(clientEventId)
            .then((receipt) => session.cancel({ clientEventId: randomUUID(), turnId: receipt.turnId }));
        },
      }),
      (error) => error instanceof TurnInterruptedError && error.inputId === clientEventId,
    );
    assert.equal((await cancelled).kind, "cancel");
    assert.equal((await session.getInteraction(clientEventId)).result.status, "interrupted");
  } finally {
    await org.close();
  }
});
