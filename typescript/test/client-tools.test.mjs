import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  UserClient,
  OutcomeUnknownError,
  TiDBLinkApiError,
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
const userFor = (baseUrl) =>
  new UserClient({ baseUrl, apiKey: "ti_user_key_" + "x".repeat(43) });
const tool = {
  type: "function",
  name: "lookup_order",
  description: "Read an order status",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
};
const json = (res, body, status = 200, headers = {}) =>
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));

test("Client Tool declarations can be sent at Session creation and read or replaced with their own ETag", async () => {
  const requests = [];
  const baseUrl = await serve(async (req, res) => {
    if (req.url === "/api/v1/user/agents/agent_1")
      return json(res, { agent: { agentId: "agent_1" } });
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: body ? JSON.parse(body) : undefined,
      etag: req.headers["if-match"],
    });
    if (req.url === "/api/v1/user/sessions")
      return json(res, { session: { sessionId: "session_1" } }, 201, {
        etag: '"model.session_1.0"',
      });
    return json(
      res,
      {
        revision: req.method === "PUT" ? 2 : 1,
        tools: req.method === "PUT" ? [] : [tool],
      },
      200,
      {
        etag:
          req.method === "PUT" ? '"tools.session_1.2"' : '"tools.session_1.1"',
      },
    );
  });
  const session = await (
    await userFor(baseUrl).getAgent("agent_1")
  ).createSession({ idempotencyKey: "create-1", tools: [tool] });
  const current = await session.getClientTools();
  assert.deepEqual(current, {
    revision: 1,
    tools: [tool],
    etag: '"tools.session_1.1"',
  });
  const replaced = await session.replaceClientTools([], {
    ifMatch: current.etag,
  });
  assert.deepEqual(replaced, {
    revision: 2,
    tools: [],
    etag: '"tools.session_1.2"',
  });
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/api/v1/user/sessions",
      body: { agentId: "agent_1", tools: [tool] },
      etag: undefined,
    },
    {
      method: "GET",
      url: "/api/v1/user/sessions/session_1/tools",
      body: undefined,
      etag: undefined,
    },
    {
      method: "PUT",
      url: "/api/v1/user/sessions/session_1/tools",
      body: { tools: [] },
      etag: '"tools.session_1.1"',
    },
  ]);
});

const call = {
  callId: "call_1",
  turnId: "turn_1",
  name: "lookup_order",
  arguments: { orderId: "order_1" },
  publishedAt: "2026-10-28T00:00:00.000Z",
  deadlineAt: "2026-10-28T00:01:00.000Z",
};
const receipt = (inputId = "output_1") => ({
  inputId,
  sequence: 2,
  kind: "client_tool_output",
  mode: "accepted",
  turnId: "turn_1",
  message: null,
  createdAt: "2026-10-28T00:00:01.000Z",
  appliedAt: null,
  rejection: null,
  result: { status: "running", completedAt: null },
});
test("pending calls retain their deadline and explicit outputs return their own recoverable receipt", async () => {
  const commands = [];
  const baseUrl = await serve(async (req, res) => {
    if (req.method === "GET") return json(res, { calls: [call] });
    let body = "";
    for await (const chunk of req) body += chunk;
    const command = JSON.parse(body);
    commands.push(command);
    json(res, { interaction: receipt(command.clientEventId) }, 202);
  });
  const session = userFor(baseUrl).session("session_1");
  assert.deepEqual(await session.listPendingClientToolCalls(), [call]);
  assert.deepEqual(
    await session.submitClientToolOutput({
      clientEventId: "output_1",
      turnId: call.turnId,
      callId: call.callId,
      output: "shipped",
    }),
    receipt(),
  );
  assert.deepEqual(
    await session.submitClientToolOutput({
      clientEventId: "error_1",
      turnId: call.turnId,
      callId: call.callId,
      error: { message: "Warehouse is unavailable" },
    }),
    receipt("error_1"),
  );
  assert.deepEqual(commands, [
    {
      type: "agent.session.input.client_tool_output",
      clientEventId: "output_1",
      data: { turnId: "turn_1", callId: "call_1", output: "shipped" },
    },
    {
      type: "agent.session.input.client_tool_output",
      clientEventId: "error_1",
      data: {
        turnId: "turn_1",
        callId: "call_1",
        error: { message: "Warehouse is unavailable" },
      },
    },
  ]);
});

for (const failure of ["disconnect", "malformed", "wrong-target"])
  test(`uncertain Client Tool output ${failure} is not repeated and retains the original command`, async () => {
    const submitted = [];
    const baseUrl = await serve(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      submitted.push(JSON.parse(body));
      if (failure === "disconnect") return res.destroy();
      if (failure === "malformed")
        return res
          .writeHead(202, { "content-type": "application/json" })
          .end("{");
      json(
        res,
        { interaction: { ...receipt(), turnId: "different-turn" } },
        202,
      );
    });
    await assert.rejects(
      userFor(baseUrl)
        .session("session_1")
        .submitClientToolOutput({
          clientEventId: "output_1",
          turnId: "turn_1",
          callId: "call_1",
          output: "app-result",
          requestId: "result-request",
        }),
      (error) =>
        error instanceof OutcomeUnknownError &&
        error.sessionId === "session_1" &&
        error.inputId === "output_1" &&
        error.turnId === "turn_1" &&
        error.requestId === "result-request",
    );
    assert.equal(submitted.length, 1);
  });

test("expired or settled calls preserve the refusal and never trigger another execution", async () => {
  const submissions = [];
  const baseUrl = await serve(async (req, res) => {
    if (req.method === "GET")
      return json(res, {
        calls: [{ ...call, deadlineAt: "2000-01-01T00:00:00.000Z" }],
      });
    let body = "";
    for await (const chunk of req) body += chunk;
    submissions.push(JSON.parse(body));
    json(
      res,
      {
        error: {
          code: "client_tool_call_settled",
          message: "No longer accepts a result",
          requestId: "expired-result",
        },
      },
      409,
    );
  });
  const session = userFor(baseUrl).session("session_1");
  assert.equal(
    (await session.listPendingClientToolCalls())[0].deadlineAt,
    "2000-01-01T00:00:00.000Z",
  );
  await assert.rejects(
    session.submitClientToolOutput({
      clientEventId: "output_1",
      turnId: "turn_1",
      callId: "call_1",
      output: "late",
    }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "client_tool_call_settled" &&
      error.requestId === "expired-result",
  );
  assert.equal(submissions.length, 1);
});

test("replacement needs an explicit revision and an unusable success is uncertain", async () => {
  const writes = [];
  const baseUrl = await serve(async (req, res) => {
    writes.push(req.method);
    json(res, { revision: 2, tools: [] });
  });
  const session = userFor(baseUrl).session("session_1");
  await assert.rejects(
    session.replaceClientTools([], { ifMatch: "" }),
    TypeError,
  );
  assert.deepEqual(writes, []);
  await assert.rejects(
    session.replaceClientTools([], { ifMatch: '"tools.session_1.1"' }),
    (error) =>
      error instanceof OutcomeUnknownError && error.sessionId === "session_1",
  );
  assert.deepEqual(writes, ["PUT"]);
});

test("invalid outputs fail before dispatch without dropping unsupported execution fields", async () => {
  const writes = [];
  const baseUrl = await serve((req, res) => {
    writes.push(req.method);
    json(res, { interaction: receipt() });
  });
  const session = userFor(baseUrl).session("session_1");
  const base = {
    clientEventId: "output_1",
    turnId: "turn_1",
    callId: "call_1",
  };
  for (const input of [
    { ...base },
    { ...base, output: "ok", error: { message: "no" } },
    { ...base, output: 123 },
    { ...base, error: { message: "" } },
    { ...base, output: "ok", clientEventId: "" },
    { ...base, output: "ok", callId: "" },
    { ...base, error: { message: "no", retry: true } },
  ])
    await assert.rejects(session.submitClientToolOutput(input), TypeError);
  assert.deepEqual(writes, []);
});
