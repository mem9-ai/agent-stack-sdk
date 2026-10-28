import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { OutcomeUnknownError, UserClient } from "../dist/index.js";

const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
};
const sessionFor = (baseUrl) =>
  new UserClient({ baseUrl, apiKey: "ti_user_key_" + "x".repeat(43) }).session(
    "session_1",
  );
const receipt = (overrides = {}) => ({
  inputId: "input_1",
  sequence: 1,
  kind: "message",
  mode: "started",
  turnId: "turn_1",
  message: {
    id: "user_1",
    role: "user",
    content: "Hello",
    createdAt: "2026-10-28T00:00:00Z",
  },
  createdAt: "2026-10-28T00:00:00Z",
  appliedAt: null,
  rejection: null,
  result: { status: "running", completedAt: null },
  ...overrides,
});
const json = (res, value, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

test("text submission exposes acceptance with the caller's stable identity and does not wait for success", async () => {
  const calls = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: JSON.parse(body),
    });
    json(res, { interaction: receipt() }, 202);
  });
  assert.deepEqual(
    await sessionFor(baseUrl).submitMessage({
      clientEventId: "input_1",
      text: "Hello",
      requestId: "http_1",
    }),
    receipt(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/user/sessions/session_1/events");
  assert.equal(calls[0].headers["x-request-id"], "http_1");
  assert.deepEqual(calls[0].body, {
    type: "agent.session.input.message",
    clientEventId: "input_1",
    data: { text: "Hello" },
  });
});

const completedAt = "2026-10-28T00:00:01Z";
const finalReceipt = (overrides = {}) =>
  receipt({
    appliedAt: "2026-10-28T00:00:00Z",
    result: { status: "succeeded", completedAt },
    ...overrides,
  });
const savedTurn = (overrides = {}) => ({
  id: "turn_1",
  sessionId: "session_1",
  status: "succeeded",
  billingTag: null,
  userMessage: {
    id: "user_1",
    role: "user",
    content: "Hello",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: "2026-10-28T00:00:00Z",
  },
  operations: [],
  assistantMessage: {
    id: "assistant_1",
    role: "assistant",
    content: "Done",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: completedAt,
  },
  createdAt: "2026-10-28T00:00:00Z",
  completedAt,
  ...overrides,
});

test("waiting polls the original interaction until incorporation and terminal success before reading the saved answer", async () => {
  const calls = [];
  let polls = 0;
  const baseUrl = await serve((req, res) => {
    calls.push([req.method, req.url]);
    if (req.url.endsWith("/turns/turn_1"))
      return json(res, { turn: savedTurn() });
    polls++;
    json(res, { interaction: polls === 1 ? receipt() : finalReceipt() });
  });
  const result = await sessionFor(baseUrl).waitForResult("input_1", {
    pollIntervalMs: 1,
  });
  assert.equal(result.type, "answer");
  assert.equal(result.text, "Done");
  assert.equal(result.inputId, "input_1");
  assert.equal(result.sessionId, "session_1");
  assert.deepEqual(result.interaction, finalReceipt());
  assert.deepEqual(calls, [
    ["GET", "/api/v1/user/sessions/session_1/interactions/input_1"],
    ["GET", "/api/v1/user/sessions/session_1/interactions/input_1"],
    ["GET", "/api/v1/user/sessions/session_1/turns/turn_1"],
  ]);
});

test("uncertain submissions preserve both identities and never automatically repeat a POST", async () => {
  for (const mode of ["disconnect", "empty", "mismatched", "server", "eof"]) {
    let posts = 0;
    const baseUrl = await serve((req, res) => {
      posts++;
      if (mode === "disconnect") return res.destroy();
      if (mode === "empty") return json(res, {});
      if (mode === "mismatched")
        return json(res, { interaction: receipt({ inputId: "other" }) });
      if (mode === "server")
        return json(
          res,
          { error: { code: "server_error", message: "uncertain" } },
          503,
        );
      res.writeHead(202, { "content-type": "application/x-ndjson" }).end("");
    });
    await assert.rejects(
      sessionFor(baseUrl).submitMessage({
        clientEventId: "input_1",
        text: "Hello",
        requestId: "http_1",
      }),
      (e) =>
        e instanceof OutcomeUnknownError &&
        e.sessionId === "session_1" &&
        e.inputId === "input_1" &&
        e.requestId === "http_1",
    );
    assert.equal(posts, 1, mode);
  }
});

test("local timeout and abort keep the original identity without cancellation or resubmission", async () => {
  const requests = [];
  const baseUrl = await serve((req, res) => {
    requests.push([req.method, req.url]);
    json(res, { interaction: receipt() });
  });
  const session = sessionFor(baseUrl);
  for (const mode of ["timeout", "abort"]) {
    const abort = new AbortController();
    const timer =
      mode === "abort"
        ? setTimeout(() => abort.abort("stop local waiting"), 15)
        : undefined;
    try {
      await assert.rejects(
        session.waitForResult("input_1", {
          timeoutMs: mode === "timeout" ? 15 : 500,
          requestId: "http_wait",
          pollIntervalMs: 2,
          signal: abort.signal,
        }),
        (e) =>
          e instanceof OutcomeUnknownError &&
          e.inputId === "input_1" &&
          e.sessionId === "session_1" &&
          e.requestId === "http_wait" &&
          (mode !== "timeout" || e.name === "TurnWaitTimeoutError"),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  assert(requests.length > 0);
  assert(
    requests.every(
      ([method, url]) =>
        method === "GET" && url.endsWith("/interactions/input_1"),
    ),
  );
});

test("failed and interrupted receipts retain the original outcome after a later execution changes the Turn", async () => {
  const { TurnFailedError, TurnInterruptedError } =
    await import("../dist/index.js");
  for (const [status, ErrorClass] of [
    ["failed", TurnFailedError],
    ["interrupted", TurnInterruptedError],
  ]) {
    const calls = [];
    const baseUrl = await serve((req, res) => {
      calls.push(req.url);
      if (req.url.endsWith("/turns/turn_1"))
        return json(res, { turn: savedTurn() });
      json(res, {
        interaction: finalReceipt({ result: { status, completedAt } }),
      });
    });
    await assert.rejects(
      sessionFor(baseUrl).waitForResult("input_1"),
      (e) =>
        e instanceof ErrorClass &&
        e.inputId === "input_1" &&
        e.sessionId === "session_1" &&
        e.turnId === "turn_1",
    );
    assert.equal(calls.length, 1);
  }
});

test("a succeeded Turn cannot establish that an unapplied or refused message succeeded", async () => {
  const { InputNotAppliedError } = await import("../dist/index.js");
  for (const overrides of [
    { mode: "steered", appliedAt: null },
    { mode: "rejected", rejection: { code: "interaction_admission_closed" } },
  ]) {
    let reads = 0;
    const baseUrl = await serve((req, res) => {
      reads++;
      json(res, { interaction: finalReceipt(overrides) });
    });
    await assert.rejects(
      sessionFor(baseUrl).waitForResult("input_1"),
      InputNotAppliedError,
    );
    assert.equal(reads, 1);
  }
});

test("a final answer must belong to the original execution and cannot be substituted by a newer or malformed Turn", async () => {
  for (const overrides of [
    { completedAt: "2026-10-28T00:02:00Z" },
    { status: "running" },
    { id: "other" },
    { assistantMessage: null },
    { assistantMessage: { ...savedTurn().assistantMessage, turnId: "other" } },
  ]) {
    const baseUrl = await serve((req, res) =>
      json(
        res,
        req.url.endsWith("/turns/turn_1")
          ? { turn: savedTurn(overrides) }
          : { interaction: finalReceipt() },
      ),
    );
    await assert.rejects(
      sessionFor(baseUrl).waitForResult("input_1"),
      OutcomeUnknownError,
    );
  }
});

test("linked clarification inputs and saved clarification answers retain their structured values", async () => {
  const received = [];
  const clarification = {
    prompt: "Choose",
    selectionMode: "multiple",
    answerChoices: ["A", "B"],
    response: { answers: ["B", "custom"], responseTurnId: "turn_2" },
  };
  const baseUrl = await serve(async (req, res) => {
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      return json(res, { interaction: finalReceipt() }, 202);
    }
    json(
      res,
      req.url.endsWith("/turns/turn_1")
        ? { turn: savedTurn({ clarificationItem: clarification }) }
        : { interaction: finalReceipt() },
    );
  });
  for (const text of ["A", ["A"], ["B", "custom"]]) {
    const result = await sessionFor(baseUrl).turn({
      clientEventId: "input_1",
      text,
      clarificationSourceTurnId: "source",
      billingTag: null,
      userFileIds: ["file_1"],
    });
    assert.equal(result.type, "clarification");
    assert.deepEqual(result.clarification, clarification);
    assert.deepEqual(received.at(-1).data, {
      text,
      clarificationSourceTurnId: "source",
      billingTag: null,
      userFileIds: ["file_1"],
    });
  }
});

test("missing command identities and unsupported options fail before dispatch", async () => {
  const session = sessionFor("http://127.0.0.1:1");
  for (const input of [
    { text: "Hello" },
    { clientEventId: "invalid key", text: "Hello" },
    { clientEventId: "input_1", text: "Hello", outputSchema: {} },
    { clientEventId: "input_1", text: [] },
    { clientEventId: "input_1", text: "Hello", retry: "safe" },
  ])
    await assert.rejects(session.submitMessage(input), TypeError);
});

test("invalid local wait settings cannot dispatch a message", async () => {
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    json(res, { interaction: receipt() }, 202);
  });
  for (const options of [
    { timeoutMs: -1 },
    { pollIntervalMs: 0 },
    { retry: "safe" },
  ])
    await assert.rejects(
      sessionFor(baseUrl).turn(
        { clientEventId: "input_1", text: "Hello" },
        options,
      ),
      TypeError,
    );
  assert.equal(calls, 0);
});

test("aborting a dispatched submission retains its recoverable command identity", async () => {
  const abort = new AbortController();
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    abort.abort("stop request");
    res.destroy();
  });
  await assert.rejects(
    sessionFor(baseUrl).submitMessage({
      clientEventId: "input_1",
      text: "Hello",
      requestId: "http_1",
      signal: abort.signal,
    }),
    (e) =>
      e instanceof OutcomeUnknownError &&
      e.inputId === "input_1" &&
      e.sessionId === "session_1" &&
      e.requestId === "http_1",
  );
  assert.equal(calls, 1);
});

test("the wait deadline also interrupts a response whose body never completes", async () => {
  const baseUrl = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"interaction":');
  });
  await assert.rejects(
    sessionFor(baseUrl).waitForResult("input_1", { timeoutMs: 20 }),
    (e) => e.name === "TurnWaitTimeoutError" && e.inputId === "input_1",
  );
});
