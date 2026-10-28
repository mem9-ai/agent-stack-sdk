import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  UserClient,
  TiDBLinkApiError,
  OutcomeUnknownError,
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
const sessionFor = (baseUrl) =>
  new UserClient({ baseUrl, apiKey: "ti_user_key_" + "x".repeat(43) }).session(
    "session_1",
  );
const frame = (cursor, type, event, payload, turnId = "turn_1") =>
  `id: ${cursor}\ndata: ${JSON.stringify({ type, sessionId: "session_1", turnId, createdAt: "2026-10-28T00:00:00.000Z", data: { event, sessionId: "session_1", turnId, seq: 1, createdAt: "2026-10-28T00:00:00.000Z", payload } })}\n\n`;

test("event subscriptions preserve fragmented UTF8, replacement snapshots, progress and opaque cursors", async () => {
  const requests = [];
  const wire =
    "\ufeff: heartbeat\r\n\r\n" +
    frame(
      "cursor-1",
      "agent.session.turn.output_text.snapshot",
      "assistant_draft",
      { text: "你好" },
    ) +
    frame(
      "cursor-2",
      "agent.session.turn.output_text.snapshot",
      "assistant_draft",
      { text: "Hello revised" },
    ) +
    frame(
      "cursor-3",
      "agent.session.turn.output_text.snapshot",
      "assistant_draft",
      { text: "" },
    ) +
    frame("cursor-4", "agent.session.turn.progress", "progress", {
      text: "Searching",
    });
  const baseUrl = await serve(async (req, res) => {
    requests.push({
      url: req.url,
      method: req.method,
      accept: req.headers.accept,
    });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    for (const byte of Buffer.from(wire)) {
      res.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  const events = await Array.fromAsync(
    sessionFor(baseUrl).events({
      cursor: "opaque +/=",
      requestId: "observe-1",
    }),
  );
  assert.deepEqual(requests, [
    {
      url: "/api/v1/user/sessions/session_1/events?stream=true&cursor=opaque+%2B%2F%3D",
      method: "GET",
      accept: "text/event-stream",
    },
  ]);
  assert.deepEqual(
    events.map((event) => event.cursor),
    ["cursor-1", "cursor-2", "cursor-3", "cursor-4"],
  );
  assert.deepEqual(
    events.map((event) => event.data.payload.text),
    ["你好", "Hello revised", "", "Searching"],
  );
  assert.equal(events[3].type, "agent.session.turn.progress");
});

const runningReceipt = {
  inputId: "input_1",
  sequence: 1,
  kind: "message",
  mode: "started",
  turnId: "turn_1",
  message: {
    id: "user_1",
    role: "user",
    content: "Hello",
    createdAt: "2026-10-28T00:00:00.000Z",
  },
  createdAt: "2026-10-28T00:00:00.000Z",
  appliedAt: "2026-10-28T00:00:00.000Z",
  rejection: null,
  result: { status: "running", completedAt: null },
};
const json = (res, value, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const completedAt = "2026-10-28T00:00:01.000Z";
const savedTurn = {
  id: "turn_1",
  sessionId: "session_1",
  executor: "full_agent",
  status: "succeeded",
  completedAt,
  assistantMessage: {
    id: "assistant_1",
    sessionId: "session_1",
    turnId: "turn_1",
    role: "assistant",
    content: "Final answer",
    createdAt: completedAt,
  },
};

test("observation uses replacement drafts and the original receipt to establish a final result", async () => {
  let reads = 0;
  const requests = [];
  const baseUrl = await serve((req, res) => {
    requests.push(req.method);
    if (req.url.endsWith("/interactions/input_1"))
      return json(res, {
        interaction:
          ++reads === 1
            ? runningReceipt
            : {
                ...runningReceipt,
                result: { status: "succeeded", completedAt },
              },
      });
    if (req.url.endsWith("/turns/turn_1"))
      return json(res, { turn: savedTurn });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame(
        "other",
        "agent.session.turn.completed",
        "turn_finished",
        { status: "succeeded" },
        "turn_other",
      ) +
        frame(
          "one",
          "agent.session.turn.output_text.snapshot",
          "assistant_draft",
          { text: "Draft" },
        ) +
        frame(
          "two",
          "agent.session.turn.output_text.snapshot",
          "assistant_draft",
          { text: "Revised" },
        ) +
        frame("three", "agent.session.turn.completed", "turn_finished", {
          status: "succeeded",
        }),
    );
  });
  const updates = await Array.fromAsync(sessionFor(baseUrl).observe("input_1"));
  assert.deepEqual(
    updates
      .filter((update) => update.type === "draft")
      .map((update) => update.text),
    ["Draft", "Revised"],
  );
  assert(!updates.some((update) => update.event?.turnId === "turn_other"));
  assert.equal(updates.at(-1).type, "result");
  assert.equal(updates.at(-1).result.inputId, "input_1");
  assert.equal(updates.at(-1).result.text, "Final answer");
  assert(requests.every((method) => method === "GET"));
});

test("replayed terminal events do not hide a running retry's new progress and drafts", async () => {
  let completed = false;
  let stream;
  let sentRetryEvents = false;
  const retry = {
    ...runningReceipt,
    inputId: "retry_1",
    kind: "retry",
    message: null,
    appliedAt: null,
  };
  const baseUrl = await serve((req, res) => {
    if (req.url.endsWith("/interactions/retry_1")) {
      json(res, {
        interaction: completed
          ? { ...retry, result: { status: "succeeded", completedAt } }
          : retry,
      });
      if (stream && !sentRetryEvents) {
        sentRetryEvents = true;
        setImmediate(() => {
          stream.write(
            frame("retry-progress", "agent.session.turn.progress", "progress", {
              text: "Continuing original work",
            }),
          );
          stream.write(
            frame(
              "retry-draft",
              "agent.session.turn.output_text.snapshot",
              "assistant_draft",
              { text: "New retry draft" },
            ),
          );
          completed = true;
          stream.end(
            frame(
              "retry-complete",
              "agent.session.turn.completed",
              "turn_finished",
              { status: "succeeded" },
            ),
          );
        });
      }
      return;
    }
    if (req.url.endsWith("/turns/turn_1"))
      return json(res, { turn: savedTurn });
    stream = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    // All frame timestamps intentionally match: the original receipt owns completion.
    res.write(
      frame(
        "original-terminal",
        "agent.session.turn.completed",
        "turn_finished",
        { status: "interrupted" },
      ),
    );
  });
  const updates = await Array.fromAsync(sessionFor(baseUrl).observe("retry_1"));
  assert.equal(updates[0].event.cursor, "original-terminal");
  assert.deepEqual(
    updates
      .filter((update) => update.type === "progress" || update.type === "draft")
      .map(({ type, text }) => ({ type, text })),
    [
      { type: "progress", text: "Continuing original work" },
      { type: "draft", text: "New retry draft" },
    ],
  );
  const result = updates.at(-1).result;
  assert.equal(result.text, "Final answer");
  assert.equal(result.inputId, "retry_1");
  assert.equal(result.interaction.kind, "retry");
  assert.equal(result.interaction.result.completedAt, completedAt);
});

test("EOF is a recoverable stopped observation with the last cursor, never successful execution", async () => {
  const baseUrl = await serve((req, res) =>
    req.url.endsWith("/interactions/input_1")
      ? json(res, { interaction: runningReceipt })
      : res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            frame(
              "last",
              "agent.session.turn.output_text.snapshot",
              "assistant_draft",
              { text: "Unfinished" },
            ),
          ),
  );
  const updates = [];
  await assert.rejects(
    async () => {
      for await (const update of sessionFor(baseUrl).observe("input_1"))
        updates.push(update);
    },
    (error) =>
      error instanceof OutcomeUnknownError &&
      error.inputId === "input_1" &&
      error.sessionId === "session_1" &&
      error.cursor === "last",
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, "draft");
});

for (const status of ["failed", "interrupted"])
  test(`a newer successful terminal event cannot overwrite the original ${status} receipt`, async () => {
    let reads = 0;
    const baseUrl = await serve((req, res) => {
      if (req.url.endsWith("/interactions/input_1"))
        return json(res, {
          interaction:
            ++reads === 1
              ? runningReceipt
              : { ...runningReceipt, result: { status, completedAt } },
        });
      res.writeHead(200, { "content-type": "text/event-stream" }).end(
        frame("newer", "agent.session.turn.completed", "turn_finished", {
          status: "succeeded",
        }),
      );
    });
    const updates = [];
    await assert.rejects(
      async () => {
        for await (const update of sessionFor(baseUrl).observe("input_1"))
          updates.push(update);
      },
      (error) =>
        error.name ===
          (status === "failed" ? "TurnFailedError" : "TurnInterruptedError") &&
        error.inputId === "input_1",
    );
    assert(!updates.some((update) => update.type === "result"));
  });

for (const mode of ["timeout", "abort", "disconnect"])
  test(`${mode} retains original observation identity and cursor without posting any command`, async () => {
    const methods = [];
    const abort = new AbortController();
    const baseUrl = await serve((req, res) => {
      methods.push(req.method);
      if (req.url.endsWith("/interactions/input_1"))
        return json(res, { interaction: runningReceipt });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        frame("resume-here", "agent.session.turn.progress", "progress", {
          text: "Running",
        }),
      );
      if (mode === "disconnect") setTimeout(() => res.destroy(), 10);
    });
    const updates = [];
    await assert.rejects(
      async () => {
        for await (const update of sessionFor(baseUrl).observe("input_1", {
          signal: abort.signal,
          timeoutMs: 100,
        })) {
          updates.push(update);
          if (mode === "abort") abort.abort();
        }
      },
      (error) =>
        error.name === "ObservationStoppedError" &&
        error.inputId === "input_1" &&
        error.sessionId === "session_1" &&
        error.turnId === "turn_1" &&
        error.cursor === "resume-here" &&
        error.timedOut === (mode === "timeout"),
    );
    assert.equal(updates[0].type, "progress");
    assert(methods.every((method) => method === "GET"));
  });

test("cursor refusals retain service error details and never reset observation", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    json(
      res,
      {
        error: {
          code: "validation_failed",
          message: "Cursor expired",
          details: { field: "cursor" },
          requestId: "service-refusal",
        },
      },
      400,
    );
  });
  await assert.rejects(
    Array.fromAsync(sessionFor(baseUrl).events({ cursor: "expired" })),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "validation_failed" &&
      error.requestId === "service-refusal" &&
      error.details.field === "cursor",
  );
  assert.deepEqual(urls, [
    "/api/v1/user/sessions/session_1/events?stream=true&cursor=expired",
  ]);
});

test("unknown events and multiline JSON are preserved without inventing terminal semantics", async () => {
  const baseUrl = await serve((req, res) =>
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        'retry: 5\rid: future\revent: future\rdata: {"type":"agent.session.future","sessionId":"session_1",\rdata: "turnId":null,"createdAt":"2026-10-28T00:00:00.000Z","data":{"future":true}}\r\r',
      ),
  );
  const [event] = await Array.fromAsync(sessionFor(baseUrl).events());
  assert.equal(event.type, "agent.session.future");
  assert.equal(event.data.future, true);
});

for (const bad of ["json", "envelope", "mime"])
  test(`invalid ${bad} cannot be accepted as an observation result`, async () => {
    const baseUrl = await serve((req, res) =>
      res
        .writeHead(200, {
          "content-type":
            bad === "mime" ? "application/json" : "text/event-stream",
        })
        .end(
          `id: x\ndata: ${bad === "json" ? "{" : JSON.stringify({ type: "agent.session.turn.completed", sessionId: "wrong", turnId: "turn_1", createdAt: "now", data: {} })}\n\n`,
        ),
    );
    await assert.rejects(
      Array.fromAsync(sessionFor(baseUrl).events()),
      (error) => error.name === "TiDBLinkError",
    );
  });

test("an already completed original receipt returns its saved result without opening another subscription", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    if (req.url.endsWith("/interactions/input_1"))
      return json(res, {
        interaction: {
          ...runningReceipt,
          result: { status: "succeeded", completedAt },
        },
      });
    if (req.url.endsWith("/turns/turn_1"))
      return json(res, { turn: savedTurn });
    res.writeHead(500).end();
  });
  const updates = await Array.fromAsync(sessionFor(baseUrl).observe("input_1"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].type, "result");
  assert.equal(updates[0].result.text, "Final answer");
  assert(!urls.some((url) => url.includes("/events")));
});
