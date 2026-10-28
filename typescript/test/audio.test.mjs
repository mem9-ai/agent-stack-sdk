import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  UserClient,
  TurnFailedError,
  TurnInterruptedError,
  OutcomeUnknownError,
  TiDBLinkApiError,
} from "../dist/index.js";
const apiKey = "ti_user_audio_" + "x".repeat(43);
const servers = [];
after(async () =>
  Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  ),
);
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const event = (name, payload, seq = 0, turnId = "turn-audio") => ({
  event: name,
  sessionId: "session-audio",
  turnId,
  seq,
  createdAt: "2026-10-28T00:00:00.000Z",
  payload,
});
const frame = (e) => `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`;
const sessionAt = (baseUrl) =>
  new UserClient({ baseUrl, apiKey }).session("session-audio");
const input = () => ({
  bytes: new Uint8Array([1, 2, 3, 4]),
  filename: "recording.wav",
  contentType: "audio/wav",
});

test("prerecorded audio sends multipart bytes and JSON billing metadata and waits for its own terminal result", async () => {
  const baseUrl = await serve(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/user/sessions/session-audio/turns/audio");
    assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(req.headers["idempotency-key"], undefined);
    const bytes = Buffer.concat(await Array.fromAsync(req));
    const form = await new Response(bytes, {
      headers: { "content-type": req.headers["content-type"] },
    }).formData();
    assert.equal(form.get("file").name, "recording.wav");
    assert.deepEqual(
      new Uint8Array(await form.get("file").arrayBuffer()),
      input().bytes,
    );
    assert.match(
      bytes.toString(),
      /name="billingTag"\r\nContent-Type: application\/json\r\n\r\nnull/,
    );
    res.writeHead(201, { "content-type": "text/event-stream" });
    res.end(
      frame(event("turn_started", {})) +
        frame(event("assistant_draft", { text: "provisional" }, 1)) +
        frame(
          event(
            "assistant_message",
            { messageId: "answer-1", text: "Final audio answer" },
            2,
          ),
        ) +
        frame(event("turn_finished", { status: "succeeded" }, 3)),
    );
  });
  assert.deepEqual(
    await sessionAt(baseUrl).audio({ ...input(), billingTag: null }),
    {
      type: "answer",
      sessionId: "session-audio",
      turnId: "turn-audio",
      messageId: "answer-1",
      text: "Final audio answer",
    },
  );
});

test("audio progress preserves fragmented SSE envelopes and complete draft snapshots", async () => {
  const events = [
    event("turn_started", {}),
    event("assistant_draft", { text: "第一版" }, 1),
    event("assistant_draft", { text: "更正" }, 2),
    event("assistant_draft", { text: "" }, 3),
    event("progress", { text: "Working" }, 4),
    event("assistant_message", { messageId: "m1", text: "Final" }, 5),
    event("turn_finished", { status: "succeeded" }, 6),
  ];
  const baseUrl = await serve(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(201, { "content-type": "text/event-stream" });
    const bytes = Buffer.from(
      ": heartbeat\r\n\r\n" + events.map(frame).join(""),
    );
    for (let i = 0; i < bytes.length; i += 3)
      res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  assert.deepEqual(
    await Array.fromAsync(sessionAt(baseUrl).streamAudio(input())),
    events,
  );
});

test("audio final failure and interruption cannot promote a provisional or earlier message to success", async () => {
  for (const status of ["failed", "interrupted"]) {
    const baseUrl = await serve(async (req, res) => {
      for await (const _ of req) {
      }
      res
        .writeHead(201, { "content-type": "text/event-stream" })
        .end(
          frame(event("turn_started", {})) +
            frame(event("assistant_draft", { text: "unfinished" }, 1)) +
            frame(
              event(
                "turn_error",
                { code: "model_provider_failed", message: "Provider failed" },
                2,
              ),
            ) +
            frame(event("turn_finished", { status }, 3)),
        );
    });
    await assert.rejects(sessionAt(baseUrl).audio(input()), (error) =>
      status === "failed"
        ? error instanceof TurnFailedError &&
          error.code === "model_provider_failed"
        : error instanceof TurnInterruptedError,
    );
  }
});

test("audio EOF, mismatched execution and truncated frames retain uncertainty without resubmitting", async () => {
  for (const suffix of [
    frame(
      event("assistant_message", { messageId: "m1", text: "Not terminal" }, 1),
    ),
    frame(event("turn_finished", { status: "succeeded" }, 1, "foreign-turn")),
    frame(event("turn_finished", { status: "succeeded" }, 1)),
    "event: turn_finished\ndata: {",
  ]) {
    let posts = 0;
    const baseUrl = await serve(async (req, res) => {
      posts++;
      for await (const _ of req) {
      }
      res
        .writeHead(201, { "content-type": "text/event-stream" })
        .end(frame(event("turn_started", {})) + suffix);
    });
    await assert.rejects(
      sessionAt(baseUrl).audio(input()),
      (error) =>
        error instanceof OutcomeUnknownError &&
        error.name === "AudioTurnStoppedError" &&
        error.turnId === "turn-audio" &&
        error.sessionId === "session-audio" &&
        error.inputId === undefined,
    );
    assert.equal(posts, 1);
  }
});

test("breaking audio consumption closes its owning response and abort preserves the known Turn identity", async () => {
  for (const abort of [false, true]) {
    let closed;
    const responseClosed = new Promise((resolve) => (closed = resolve));
    const baseUrl = await serve(async (req, res) => {
      for await (const _ of req) {
      }
      res.once("close", closed);
      res.writeHead(201, { "content-type": "text/event-stream" });
      res.write(frame(event("turn_started", {})));
    });
    const controller = new AbortController();
    const stream = sessionAt(baseUrl).streamAudio({
      ...input(),
      signal: controller.signal,
    });
    assert.equal((await stream.next()).value.event, "turn_started");
    if (abort) {
      controller.abort();
      await assert.rejects(
        stream.next(),
        (error) =>
          error.name === "AudioTurnStoppedError" &&
          error.turnId === "turn-audio",
      );
    } else await stream.return();
    let timeout;
    await Promise.race([
      responseClosed,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Audio response stayed open")),
          1000,
        );
      }),
    ]);
    clearTimeout(timeout);
  }
});

test("audio pre-stream refusal keeps the actual service error and local invalid input never dispatches", async () => {
  let requests = 0;
  const baseUrl = await serve(async (req, res) => {
    requests++;
    for await (const _ of req) {
    }
    res
      .writeHead(429, {
        "content-type": "application/json",
        "x-request-id": "audio-budget",
      })
      .end(
        JSON.stringify({
          error: {
            code: "llm_spend_limit_exhausted",
            message: "Limit exhausted",
          },
        }),
      );
  });
  await assert.rejects(
    sessionAt(baseUrl).audio(input()),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "llm_spend_limit_exhausted" &&
      error.requestId === "audio-budget",
  );
  await assert.rejects(
    sessionAt(baseUrl).audio({ ...input(), bytes: new Uint8Array() }),
    /prerecorded/,
  );
  await assert.rejects(
    sessionAt(baseUrl).audio({
      ...input(),
      bytes: new Uint8Array(25 * 1024 * 1024 + 1),
    }),
    /prerecorded/,
  );
  await assert.rejects(
    sessionAt(baseUrl).audio({ ...input(), clientEventId: "not-supported" }),
    /clientEventId/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sessionAt(baseUrl).audio({ ...input(), signal: controller.signal }),
  );
  assert.equal(requests, 1);
});
