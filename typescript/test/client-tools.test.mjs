import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  OrganizationClient,
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
  new OrganizationClient({ baseUrl, apiKey: "ti_org_key_" + "x".repeat(43) }).user("user_1");
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
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: body ? JSON.parse(body) : undefined,
      etag: req.headers["if-match"],
    });
    if (req.url === "/api/v1/org/users/user_1/sessions")
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
  const session = await userFor(baseUrl).createSession({
    templateId: "template_1",
    idempotencyKey: "create-1",
    tools: [tool],
  });
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
      url: "/api/v1/org/users/user_1/sessions",
      body: { agentTemplateId: "template_1", tools: [tool] },
      etag: undefined,
    },
    {
      method: "GET",
      url: "/api/v1/org/users/user_1/sessions/session_1/tools",
      body: undefined,
      etag: undefined,
    },
    {
      method: "PUT",
      url: "/api/v1/org/users/user_1/sessions/session_1/tools",
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

test("Client Tool read options cannot turn a read into an unsafe replacement", async () => {
  const requests = [];
  const baseUrl = await serve((req, res) => {
    requests.push(req.method);
    json(res, { revision: 2, tools: [], calls: [] }, 200, {
      etag: '"tools.session_1.2"',
    });
  });
  const session = userFor(baseUrl).session("session_1");
  await assert.rejects(
    session.getClientTools({
      method: "PUT",
      body: { tools: [] },
      ifMatch: '"tools.session_1.1"',
    }),
    TypeError,
  );
  assert.deepEqual(requests, []);
});
