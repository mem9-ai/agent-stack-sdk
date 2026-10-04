import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import {
  ConflictError,
  InvalidTurnEventError,
  OutcomeUnknownError,
  TurnFailedError,
  TurnInterruptedError,
  UserClient,
} from "../dist/index.js";

const servers = [];
const userApiKey = "ti_user_" + "key_" + "x".repeat(43);

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
    apiKey: userApiKey,
  }).session("session_1");

const event = (eventName, seq, payload) => ({
  event: eventName,
  turnId: "turn_1",
  sessionId: "session_1",
  agentRunId: "run_1",
  seq,
  createdAt: `2026-08-25T00:00:0${seq}.000Z`,
  payload: eventName === "turn_started" ? { inputId: "message-001", ...payload } : payload,
});

const writeEvents = (response, events) => {
  response.writeHead(201, { "content-type": "application/x-ndjson" });
  response.end(events.map((value) => JSON.stringify(value)).join("\n"));
};

test("the Turn stream validates ordered events across chunks and heartbeats", async () => {
  const requests = [];
  const events = [
    event("turn_started", 0, { execution: { model: "gpt-5.6-sol" } }),
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
  for await (const item of sessionFor(baseUrl).streamTurn({ inputId: "message-001",
    text: "Hello",
    billingTag: { key: "customer", value: "acme" },
  })) {
    received.push(item);
  }

  assert.deepEqual(received, events);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/api/v1/sessions/session_1/turns");
  assert.deepEqual(JSON.parse(requests[0].body), {
    inputId: "message-001",
    input: { type: "text", text: "Hello" },
    billingTag: { key: "customer", value: "acme" },
  });
  assert.equal(requests[0].headers["x-agent9-project-id"], undefined);
  assert.equal(requests[0].headers["x-ti-project-id"], undefined);
});

test("malformed Turn payloads are rejected at the package boundary", async () => {
  const invalid = [
    event("progress", 0, { text: "Missing start" }),
    event("turn_started", 0, { execution: { model: "unsupported-model" } }),
    event("progress", 0, { text: 42 }),
    event("assistant_message", 0, {
      messageId: "message_1",
      text: "Choose one",
      clarificationItem: { prompt: "Choose one", answerChoices: ["A", "B"] },
    }),
    event("assistant_message", 0, {
      messageId: "message_1",
      text: "Choose one",
      clarificationItem: {
        prompt: "Choose one",
        selectionMode: "single",
        answerChoices: ["A", "B", "C", "D"],
      },
    }),
    event("assistant_message", 0, {
      messageId: "message_1",
      text: "Choose one",
      clarificationItem: {
        prompt: "Choose one",
        selectionMode: "single",
        answerChoices: ["A", "B"],
        response: { text: "A", answers: ["A"], responseTurnId: "turn_2" },
      },
    }),
  ];
  let request = 0;
  const baseUrl = await serve((_request, response) => {
    writeEvents(response, [invalid[request++]]);
  });

  for (let attempt = 0; attempt < invalid.length; attempt += 1) {
    await assert.rejects(
      async () => {
        for await (const _item of sessionFor(baseUrl).streamTurn({ inputId: "message-001", text: "Hello" })) {
          // consume
        }
      },
      InvalidTurnEventError,
    );
  }
});

test("linked Clarification inputs preserve canonical single and ordered multiple answers", async () => {
  const bodies = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    writeEvents(response, [
      event("turn_started", 0, {}),
      event("assistant_message", 1, { messageId: "message_1", text: "Continued" }),
      event("turn_finished", 2, { status: "succeeded" }),
    ]);
  });
  const session = sessionFor(baseUrl);

  await session.turn({ inputId: "message-001", text: "A", clarificationSourceTurnId: "turn_source" });
  await session.turn({ inputId: "message-001", text: ["A"], clarificationSourceTurnId: "turn_source" });
  await session.turn({ inputId: "message-001",
    text: ["A", "B", "Custom"],
    clarificationSourceTurnId: "turn_source",
  });

  assert.deepEqual(
    bodies.map(({ input, clarificationSourceTurnId }) => ({ input, clarificationSourceTurnId })),
    [
      {
        input: { type: "text", text: "A" },
        clarificationSourceTurnId: "turn_source",
      },
      {
        input: { type: "text", text: ["A"] },
        clarificationSourceTurnId: "turn_source",
      },
      {
        input: { type: "text", text: ["A", "B", "Custom"] },
        clarificationSourceTurnId: "turn_source",
      },
    ],
  );
});

test("removed structured Turn output is rejected instead of ignored", async () => {
  await assert.rejects(
    sessionFor("https://agent.example.com").streamTurn({ inputId: "message-001",
      text: "Hello",
      outputSchema: { type: "object" },
    }).next(),
    /outputSchema is not supported/,
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
      for await (const _item of sessionFor(baseUrl).streamTurn({ inputId: "message-001", text: "Hello" })) {
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

  assert.deepEqual(await session.turn({ inputId: "message-001", text: "answer" }), {
    type: "answer",
    turnId: "turn_1",
    messageId: "message_1",
    text: "Final answer",
  });
  assert.deepEqual(await session.turn({ inputId: "message-001", text: "clarify" }), {
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

  await assert.rejects(session.turn({ inputId: "message-001", text: "failed" }), (error) => {
    assert(error instanceof TurnFailedError);
    assert.equal(error.code, "failed_code");
    assert.equal(error.turnId, "turn_1");
    return true;
  });
  await assert.rejects(session.turn({ inputId: "message-001", text: "interrupted" }), TurnInterruptedError);
});


const interaction = (overrides = {}) => ({
  inputId: "message-001", sequence: 1, kind: "message", mode: "started", turnId: "turn_1",
  message: { id: "message_user_1", role: "user", content: "Hello", createdAt: "2026-10-04T00:00:00Z" },
  createdAt: "2026-10-04T00:00:00Z", appliedAt: null, rejection: null,
  result: { status: "running", completedAt: null }, ...overrides,
});

test("active input and identical replay return a distinct saved receipt in both Turn APIs", async () => {
  const replies = [
    [202, interaction({ mode: "steered" })],
    [200, interaction({ result: { status: "succeeded", completedAt: "2026-10-04T00:00:01Z" } })],
  ];
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    calls.push(JSON.parse(raw));
    const [status, saved] = replies[calls.length - 1];
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ interaction: saved }));
  });
  const session = sessionFor(baseUrl);
  assert.deepEqual(await session.turn({ inputId: "message-001", text: "Hello" }), { type: "receipt", replayed: false, interaction: replies[0][1] });
  const items = [];
  for await (const item of session.streamTurn({ inputId: "message-001", text: "Hello" })) items.push(item);
  assert.deepEqual(items, [{ type: "receipt", replayed: true, interaction: replies[1][1] }]);
  assert.deepEqual(calls, [{ inputId: "message-001", input: { type: "text", text: "Hello" } }, { inputId: "message-001", input: { type: "text", text: "Hello" } }]);
});

test("a lost cancellation acknowledgment preserves its input and Turn for explicit retry", async () => {
  const calls = [];
  const cancelled = interaction({ inputId: "cancel-001", kind: "cancel", mode: "cancelled", sequence: 2, message: null });
  const baseUrl = await serve(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    if (calls.length === 1) return request.socket.destroy();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ interaction: cancelled }));
  });
  const session = sessionFor(baseUrl);
  await assert.rejects(session.stopTurn("turn_1", { inputId: "cancel-001" }), error => {
    assert(error instanceof OutcomeUnknownError);
    assert.equal(error.inputId, "cancel-001"); assert.equal(error.turnId, "turn_1"); return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(await session.getInteraction("cancel-001"), cancelled);
  assert.deepEqual(await session.stopTurn("turn_1", { inputId: "cancel-001" }), { type: "receipt", replayed: true, interaction: cancelled });
  assert.deepEqual(calls, [
    { method: "POST", url: "/api/v1/sessions/session_1/turns/turn_1/stop", body: { inputId: "cancel-001" } },
    { method: "GET", url: "/api/v1/sessions/session_1/interactions/cancel-001", body: null },
    { method: "POST", url: "/api/v1/sessions/session_1/turns/turn_1/stop", body: { inputId: "cancel-001" } },
  ]);
});

const bounded = async (promise, label) => {
  let timeout;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Timed out: " + label)), 2000); })]); }
  finally { clearTimeout(timeout); }
};

test("normal terminal consumption waits for EOF without cancelling the owning response", async context => {
  let owner;
  const opened = Promise.withResolvers();
  const closed = Promise.withResolvers();
  let endedNormally = false;
  const baseUrl = await serve((_request, response) => {
    owner = response;
    response.once("close", () => closed.resolve(response.writableEnded));
    response.writeHead(201, { "content-type": "application/x-ndjson" });
    response.write([event("turn_started", 0, {}), event("assistant_message", 1, { messageId: "message_1", text: "Done" }), event("turn_finished", 2, { status: "succeeded" })].map(item => JSON.stringify(item)).join("\n") + "\n");
    opened.resolve();
  });
  context.after(() => owner?.destroy());
  const iterator = sessionFor(baseUrl).streamTurn({ inputId: "message-001", text: "Hello" });
  assert.equal((await iterator.next()).value.event, "turn_started");
  assert.equal((await iterator.next()).value.event, "assistant_message");
  assert.equal((await iterator.next()).value.event, "turn_finished");
  await bounded(opened.promise, "owning response");
  const ending = iterator.next();
  const nextLoop = new Promise(resolve => setImmediate(() => resolve("awaiting-eof")));
  assert.equal(await Promise.race([ending.then(() => "closed-early"), nextLoop]), "awaiting-eof");
  owner.end(); endedNormally = true;
  assert.deepEqual(await bounded(ending, "normal EOF"), { value: undefined, done: true });
  assert.equal(await bounded(closed.promise, "normal server close"), true);
  assert.equal(endedNormally, true);
});


test("AbortSignal and iterator break close the original owning socket before completion", async context => {
  for (const action of ["abort", "break"]) {
    let owner; const closed = Promise.withResolvers();
    const baseUrl = await serve((_request, response) => {
      owner = response;
      response.socket.once("close", () => closed.resolve(response.writableEnded));
      response.writeHead(201, { "content-type": "application/x-ndjson" });
      response.write(JSON.stringify(event("turn_started", 0, {})) + "\n");
    });
    context.after(() => owner?.destroy());
    const controller = new AbortController();
    const iterator = sessionFor(baseUrl).streamTurn({ inputId: "message-001", text: "wait", signal: controller.signal });
    if (action === "abort") {
      await iterator.next(); controller.abort(new Error("stop waiting"));
      await assert.rejects(iterator.next(), error => {
        assert(error instanceof OutcomeUnknownError); assert.equal(error.inputId, "message-001"); assert.equal(error.turnId, "turn_1"); return true;
      });
    } else {
      for await (const _item of iterator) break;
    }
    assert.equal(await bounded(closed.promise, action + " server socket close"), false);
  }
});

test("steering and stop acknowledgments leave the original execution response readable", async context => {
  let owner; let ownerClosed = false;
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); calls.push({ url: request.url, body });
    if (body.inputId === "message-001") {
      owner = response; response.once("close", () => { ownerClosed = true; });
      response.writeHead(201, { "content-type": "application/x-ndjson" });
      return response.write(JSON.stringify(event("turn_started", 0, {})) + "\n");
    }
    const cancel = request.url.endsWith("/stop");
    response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ interaction: interaction({ inputId: cancel ? "cancel-001" : "steer-001", sequence: cancel ? 3 : 2, kind: cancel ? "cancel" : "message", mode: cancel ? "cancelled" : "steered", message: cancel ? null : { id: "message_steer", role: "user", content: "Add details", createdAt: "2026-10-04T00:00:00Z" } }) }));
  });
  context.after(() => owner?.destroy());
  const session = sessionFor(baseUrl);
  const original = session.streamTurn({ inputId: "message-001", text: "Hello" });
  assert.equal((await original.next()).value.event, "turn_started");
  const [steered, stopped] = await Promise.all([session.turn({ inputId: "steer-001", text: "Add details" }), session.stopTurn("turn_1", { inputId: "cancel-001" })]);
  assert.equal(steered.interaction.mode, "steered"); assert.equal(stopped.interaction.mode, "cancelled");
  assert.equal(ownerClosed, false);
  owner.write(JSON.stringify(event("progress", 1, { text: "Still readable" })) + "\n");
  assert.equal((await bounded(original.next(), "progress after auxiliary close")).value.payload.text, "Still readable");
  owner.end(JSON.stringify(event("turn_finished", 2, { status: "interrupted" })) + "\n");
  assert.equal((await original.next()).value.payload.status, "interrupted");
  assert.equal((await original.next()).done, true);
  assert.equal(calls.length, 3);
});

test("status/content-type mismatches and another input's receipt cannot become an execution or recovery", async () => {
  const cases = [
    [200, "application/x-ndjson", JSON.stringify(event("turn_started", 0, {}))],
    [202, "application/x-ndjson", JSON.stringify(event("turn_started", 0, {}))],
    [201, "application/json", JSON.stringify({ interaction: interaction() })],
    [202, "application/json", JSON.stringify({ interaction: interaction({ inputId: "foreign-input", mode: "steered" }) })],
    [200, "application/json", JSON.stringify({ interaction: interaction({ kind: "cancel", mode: "cancelled", message: null }) })],
    [202, "application/json", JSON.stringify({ interaction: interaction() })],
  ];
  let requests = 0;
  const baseUrl = await serve((_request, response) => {
    const [status, type, body] = cases[requests++]; response.writeHead(status, { "content-type": type, "x-request-id": "service-trace" }).end(body);
  });
  for (let i = 0; i < cases.length; i += 1) await assert.rejects(sessionFor(baseUrl).turn({ inputId: "message-001", text: "Hello" }), error => error instanceof OutcomeUnknownError && error.inputId === "message-001" && error.requestId === "service-trace");
  assert.equal(requests, cases.length);
});

test("receipt projections and malformed diagnostics exclude unexpected secret and debug fields", async () => {
  const marker = "SENSITIVE_RESPONSE_MARKER";
  const saved = interaction({ result: { status: "interrupted", completedAt: "2026-10-04T00:00:01Z" } });
  const extra = { ...saved, credential: marker, message: { ...saved.message, token: marker }, result: { ...saved.result, debug: marker } };
  const replies = [
    [200, "application/json", JSON.stringify({ interaction: extra, debug: marker })],
    [200, "application/json", '{"interaction":"' + marker],
    [201, "application/x-ndjson", '{"secret":"' + marker],
    [201, "application/x-ndjson", JSON.stringify(event("turn_started", 0, {})) + "\n"],
  ];
  let requests = 0;
  const baseUrl = await serve((_request, response) => { const [status, type, body] = replies[requests++]; response.writeHead(status, { "content-type": type, "x-request-id": "replaced-trace" }).end(body); });
  assert.deepEqual(await sessionFor(baseUrl).turn({ inputId: "message-001", text: "Hello" }), { type: "receipt", replayed: true, interaction: saved });
  for (let i = 1; i < replies.length; i += 1) await assert.rejects(sessionFor(baseUrl).turn({ inputId: "message-001", text: "Hello" }), error => {
    assert(error instanceof OutcomeUnknownError); assert.equal(error.inputId, "message-001"); assert.equal(error.requestId, "replaced-trace");
    for (const rendered of [String(error), error.stack, JSON.stringify(error), String(error.cause)]) assert(!rendered.includes(marker));
    return true;
  });
  assert.equal(requests, 4);
});

test("input conflicts and durable refusals retain their explicit service outcome", async () => {
  let requests = 0;
  const calls = [];
  const refused = interaction({ mode: "rejected", message: null, rejection: { code: "interaction_admission_closed" }, result: { status: "interrupted", completedAt: "2026-10-04T00:00:01Z" } });
  const baseUrl = await serve(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/v1/sessions/session_1/interactions/message-001") return response.end(JSON.stringify({ interaction: refused }));
    requests += 1;
    response.writeHead(409).end(JSON.stringify({ error: { code: ["interaction_input_conflict", "interaction_target_conflict", "interaction_admission_closed"][Math.min(requests, 3) - 1], message: "Refused" } }));
  });
  for (const code of ["interaction_input_conflict", "interaction_target_conflict", "interaction_admission_closed"]) await assert.rejects(sessionFor(baseUrl).turn({ inputId: "message-001", text: "Hello" }), error => error instanceof ConflictError && error.code === code && error.inputId === "message-001");
  assert.equal(requests, 3);
  await assert.rejects(sessionFor(baseUrl).turn({ inputId: "message-001", text: "Hello" }), error => error instanceof ConflictError && error.status === 409 && error.code === "interaction_admission_closed" && error.inputId === "message-001");
  assert.equal(requests, 4);
  assert.deepEqual(await sessionFor(baseUrl).getInteraction("message-001"), refused);
  assert.equal(requests, 4);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.slice(-3).map(call => [call.method, call.url]), [
    ["POST", "/api/v1/sessions/session_1/turns"],
    ["POST", "/api/v1/sessions/session_1/turns"],
    ["GET", "/api/v1/sessions/session_1/interactions/message-001"],
  ]);
  assert.deepEqual(calls.filter(call => call.method === "POST").slice(-2).map(call => call.body), [
    { inputId: "message-001", input: { type: "text", text: "Hello" } },
    { inputId: "message-001", input: { type: "text", text: "Hello" } },
  ]);
});
