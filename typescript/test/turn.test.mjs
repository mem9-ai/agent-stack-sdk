import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import {
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
  UserClient,
} from "../dist/index.js";

const servers = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const sessionFor = (baseUrl) =>
  new UserClient({
    baseUrl,
    apiKey: "ag9_uak_key_secret_value_that_is_long_enough",
    projectId: "project_1",
  }).session("session_1");

const event = (eventName, seq, payload) => ({
  event: eventName,
  turnId: "turn_1",
  sessionId: "session_1",
  agentRunId: "run_1",
  seq,
  createdAt: `2026-08-25T00:00:0${seq}.000Z`,
  payload,
});

const writeEvents = (response, events) => {
  response.writeHead(201, { "content-type": "application/x-ndjson" });
  response.end(events.map((value) => JSON.stringify(value)).join("\n"));
};

test("the Turn stream validates ordered events across chunks and heartbeats", async () => {
  const requests = [];
  const events = [
    event("turn_started", 0, { execution: { backend: "codex", model: "gpt-5.6-sol", modelReasoningEffort: null } }),
    event("progress", 1, { text: "Working" }),
    event("assistant_message", 2, { messageId: "message_1", text: "Done" }),
    event("turn_finished", 3, { status: "succeeded" }),
  ];
  const payload = events.map((value) => JSON.stringify(value)).join("\n\n") + "\n";
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body, headers: request.headers });
    response.writeHead(201, { "content-type": "application/x-ndjson" });
    let offset = 0;
    for (const boundary of [3, 17, 61, 109, payload.length]) {
      response.write(payload.slice(offset, boundary));
      offset = boundary;
    }
    response.end();
  });

  const received = [];
  for await (const item of sessionFor(baseUrl).streamTurn({ text: "Hello" })) received.push(item);

  assert.deepEqual(received, events);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/api/sessions/session_1/turns");
  assert.deepEqual(JSON.parse(requests[0].body), { input: { type: "text", text: "Hello" } });
  assert.equal(requests[0].headers["x-agent9-project-id"], "project_1");
});

test("malformed Turn events are rejected at the package boundary", async () => {
  const baseUrl = await serve((_request, response) => {
    writeEvents(response, [event("progress", 0, { text: 42 })]);
  });

  await assert.rejects(
    async () => {
      for await (const _item of sessionFor(baseUrl).streamTurn({ text: "Hello" })) {
        // consume
      }
    },
    InvalidTurnEventError,
  );
});

test("a stream ending without a terminal event is outcome unknown and is not replayed", async () => {
  let requests = 0;
  const baseUrl = await serve((_request, response) => {
    requests += 1;
    writeEvents(response, [event("turn_started", 0, {})]);
  });

  await assert.rejects(
    async () => {
      for await (const _item of sessionFor(baseUrl).streamTurn({ text: "Hello" })) {
        // consume
      }
    },
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.equal(error.turnId, "turn_1");
      assert.match(error.requestId, /^[0-9a-f-]{36}$/);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("the collected Turn API returns answers and structured clarifications", async () => {
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const clarification = input.input.text === "clarify";
    writeEvents(response, [
      event("turn_started", 0, {}),
      event("assistant_message", 1, {
        messageId: "message_1",
        text: clarification ? "Choose one" : "Final answer",
        ...(clarification
          ? {
              clarificationItem: {
                prompt: "Choose one",
                selectionMode: "single",
                answerChoices: ["A", "B"],
              },
            }
          : {}),
      }),
      event("turn_finished", 2, { status: "succeeded" }),
    ]);
  });
  const session = sessionFor(baseUrl);

  assert.deepEqual(await session.turn({ text: "answer" }), {
    type: "answer",
    turnId: "turn_1",
    messageId: "message_1",
    text: "Final answer",
  });
  assert.deepEqual(await session.turn({ text: "clarify" }), {
    type: "clarification",
    turnId: "turn_1",
    messageId: "message_1",
    text: "Choose one",
    clarification: {
      prompt: "Choose one",
      selectionMode: "single",
      answerChoices: ["A", "B"],
    },
  });
});

test("known failed and interrupted Turns use distinct errors", async () => {
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const status = JSON.parse(body).input.text;
    writeEvents(response, [
      event("turn_started", 0, {}),
      event("turn_error", 1, { code: `${status}_code`, message: `${status} message` }),
      event("turn_finished", 2, { status }),
    ]);
  });
  const session = sessionFor(baseUrl);

  await assert.rejects(session.turn({ text: "failed" }), (error) => {
    assert(error instanceof TurnFailedError);
    assert.equal(error.code, "failed_code");
    assert.equal(error.turnId, "turn_1");
    return true;
  });
  await assert.rejects(session.turn({ text: "interrupted" }), TurnInterruptedError);
});

test("AbortSignal stops local Turn waiting", async () => {
  const sockets = new Set();
  const baseUrl = await serve((_request, response) => {
    sockets.add(response.socket);
    response.socket.once("close", () => sockets.delete(response.socket));
    response.writeHead(201, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify(event("turn_started", 0, {}))}\n`);
  });
  const controller = new AbortController();
  const waiting = sessionFor(baseUrl).turn({ text: "wait", signal: controller.signal });
  setTimeout(() => controller.abort(new Error("stop waiting")), 10);

  await assert.rejects(waiting, /stop waiting/);
  for (const socket of sockets) socket.destroy();
});
