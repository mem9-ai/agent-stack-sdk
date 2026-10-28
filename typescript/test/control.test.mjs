import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  OutcomeUnknownError,
  TiDBLinkApiError,
  UserClient,
} from "../dist/index.js";

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
const sessionFor = (baseUrl) =>
  new UserClient({ baseUrl, apiKey: "ti_user_key_" + "x".repeat(43) }).session(
    "session_1",
  );
const json = (res, value, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const receipt = (kind, overrides = {}) => ({
  inputId: "command_1",
  sequence: 2,
  kind,
  mode: kind === "cancel" ? "cancelled" : "started",
  turnId: "turn_1",
  message: null,
  createdAt: "2026-10-28T00:00:00Z",
  appliedAt: null,
  rejection: null,
  result: { status: "running", completedAt: null },
  ...overrides,
});

test("cancellation targets one Turn with stable command identity and reports acceptance before termination", async () => {
  const requests = [];
  const baseUrl = await serve(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: JSON.parse(text),
      requestId: req.headers["x-request-id"],
    });
    json(res, { interaction: receipt("cancel") }, 202);
  });
  const accepted = await sessionFor(baseUrl).cancel({
    clientEventId: "command_1",
    turnId: "turn_1",
    requestId: "request_1",
  });
  assert.equal(accepted.result.status, "running");
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/api/v1/user/sessions/session_1/events",
      body: {
        type: "agent.session.input.cancel",
        clientEventId: "command_1",
        data: { turnId: "turn_1" },
      },
      requestId: "request_1",
    },
  ]);
});

const completedAt = "2026-10-28T00:00:02Z";
test("explicit retry keeps its own receipt and wait result while the original input remains interrupted", async () => {
  const original = receipt("message", {
    inputId: "original",
    mode: "started",
    appliedAt: "2026-10-28T00:00:00Z",
    message: {
      id: "user_1",
      role: "user",
      content: "Hello",
      createdAt: "2026-10-28T00:00:00Z",
    },
    result: { status: "interrupted", completedAt: "2026-10-28T00:00:01Z" },
  });
  const retry = receipt("retry", {
    result: { status: "succeeded", completedAt },
  });
  const commands = [];
  const baseUrl = await serve(async (req, res) => {
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      commands.push(JSON.parse(text));
      return json(
        res,
        {
          event: {
            clientEventId: "command_1",
            sessionId: "session_1",
            turnId: "turn_1",
            disposition: "retrying",
          },
        },
        202,
      );
    }
    if (req.url.endsWith("/interactions/original"))
      return json(res, { interaction: original });
    if (req.url.endsWith("/interactions/command_1"))
      return json(res, { interaction: retry });
    json(res, {
      turn: {
        id: "turn_1",
        sessionId: "session_1",
        status: "succeeded",
        completedAt,
        assistantMessage: {
          id: "answer_1",
          sessionId: "session_1",
          turnId: "turn_1",
          role: "assistant",
          content: "Retried answer",
          createdAt: completedAt,
        },
      },
    });
  });
  const session = sessionFor(baseUrl);
  const admitted = await session.retry({
    clientEventId: "command_1",
    turnId: "turn_1",
  });
  assert.equal(admitted.disposition, "retrying");
  assert.deepEqual(commands, [
    {
      type: "agent.session.input.retry",
      clientEventId: "command_1",
      data: { turnId: "turn_1" },
    },
  ]);
  const result = await session.waitForResult(admitted.clientEventId);
  assert.equal(result.text, "Retried answer");
  assert.equal(result.inputId, "command_1");
  assert.deepEqual(await session.getInteraction("original"), original);
  assert.equal(commands.length, 1);
});

test("control uncertainty retains the exact command and never repeats effects", async () => {
  for (const method of ["cancel", "retry"]) {
    for (const response of [
      "disconnect",
      "unusable",
      "wrong-target",
      "server-error",
    ]) {
      let effects = 0;
      const baseUrl = await serve((req, res) => {
        effects += 1;
        if (response === "disconnect") return req.socket.destroy();
        if (response === "server-error")
          return json(
            res,
            {
              error: {
                code: "service_unavailable",
                message: "Unknown command outcome",
              },
            },
            503,
          );
        if (response === "wrong-target")
          return json(
            res,
            method === "cancel"
              ? { interaction: receipt("cancel", { turnId: "other" }) }
              : {
                  event: {
                    clientEventId: "command_1",
                    sessionId: "other",
                    turnId: "turn_1",
                    disposition: "retrying",
                  },
                },
          );
        json(res, {});
      });
      await assert.rejects(
        sessionFor(baseUrl)[method]({
          clientEventId: "command_1",
          turnId: "turn_1",
        }),
        (error) =>
          error instanceof OutcomeUnknownError &&
          error.inputId === "command_1" &&
          error.turnId === "turn_1" &&
          error.sessionId === "session_1",
      );
      assert.equal(effects, 1);
    }
  }
});

test("refused controls preserve the service error and cannot substitute a new message", async () => {
  for (const [method, status, code] of [
    ["retry", 400, "checkpoint_runtime_unavailable"],
    ["cancel", 409, "interaction_admission_closed"],
    ["retry", 403, "forbidden"],
    ["cancel", 404, "session_not_found"],
  ]) {
    const commands = [];
    const baseUrl = await serve(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      commands.push(JSON.parse(text));
      json(
        res,
        {
          error: {
            code,
            message: "Refused",
            details: { target: "turn_1" },
            requestId: "refusal_1",
          },
        },
        status,
      );
    });
    await assert.rejects(
      sessionFor(baseUrl)[method]({
        clientEventId: "command_1",
        turnId: "turn_1",
      }),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.code === code &&
        error.status === status &&
        error.requestId === "refusal_1" &&
        error.details.target === "turn_1",
    );
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, `agent.session.input.${method}`);
  }
});

test("invalid control identities and aborted-before-dispatch commands perform no request", async () => {
  let requests = 0;
  const baseUrl = await serve((_req, res) => {
    requests += 1;
    json(res, {});
  });
  for (const method of ["cancel", "retry"]) {
    for (const input of [
      { turnId: "turn_1" },
      { clientEventId: "command_1" },
      { clientEventId: "command_1", turnId: "" },
      { clientEventId: "command_1", turnId: "turn_1", obsolete: true },
    ])
      await assert.rejects(sessionFor(baseUrl)[method](input), TypeError);
    await assert.rejects(
      sessionFor(baseUrl)[method]({
        clientEventId: "command_1",
        turnId: "turn_1",
        signal: AbortSignal.abort(),
      }),
    );
  }
  assert.equal(requests, 0);
});
