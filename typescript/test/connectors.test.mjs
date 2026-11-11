import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  ConflictError,
  ConnectorAuthError,
  ConnectorKeySet,
  OrganizationClient,
  readConnectorCallContext,
  verifyConnectorCallback,
} from "../dist/index.js";
import { createConnectorHandler } from "../examples/http-connector.mjs";

const apiKey = "ti_org_connect_" + "x".repeat(43);
const baseUrl = "https://tidb-link.test";
const organizationId = "org_1";
const connectorId = "conn_00000000-0000-0000-0000-000000000001";
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))));

const signing = generateKeyPairSync("ed25519");
const jwk = { ...signing.publicKey.export({ format: "jwk" }), kid: "k1", alg: "EdDSA", use: "sig" };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims = {}, header = {}, key = signing.privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: "k1", ...header })}.${encode({
    iss: "tidb-link/connector-callback/v1",
    aud: "tidb-link/connector",
    organizationId,
    connectorId,
    iat: now,
    exp: now + 60,
    ...claims,
  })}`;
  return `Bearer ${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
};
const keySet = () => {
  const requests = [];
  const keys = new ConnectorKeySet({
    baseUrl,
    fetch: async (url) => {
      requests.push(String(url));
      return json({ keys: [jwk] });
    },
  });
  return { keys, requests };
};

const registration = {
  connectorId,
  organizationId,
  displayName: "Orders",
  endpointUrl: "https://orders.example.com/mcp",
  endpointVersion: 1,
  transport: "streamable_http",
  status: "inactive",
  connectorVersion: 1,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};

test("Connectors are registered, edited, activated and deactivated with their expected version", async () => {
  const calls = [];
  const organization = new OrganizationClient({
    baseUrl,
    apiKey,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({
        method: init.method ?? "GET",
        path: url.pathname.replace("/api/v1/org", ""),
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      if (url.pathname.endsWith("/connectors") && (init.method ?? "GET") === "GET") return json({ connectors: [registration] });
      if (url.pathname.endsWith("/deactivate"))
        return json({ error: { code: "resource_conflict", message: "Version changed" } }, 409);
      return json(registration, init.method === "POST" ? 201 : 200);
    },
  });
  const { connectors } = organization;
  await connectors.register({ displayName: "Orders", endpointUrl: registration.endpointUrl });
  assert.equal((await connectors.list())[0].connectorId, connectorId);
  await connectors.get(connectorId);
  await connectors.update(connectorId, { displayName: "Orders v2" }, { expectedConnectorVersion: 1 });
  await connectors.activate(connectorId, { expectedConnectorVersion: 2 });
  await assert.rejects(
    connectors.deactivate(connectorId, { expectedConnectorVersion: 1 }),
    ConflictError,
  );
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`),
    [
      `POST /connectors {"displayName":"Orders","endpointUrl":"https://orders.example.com/mcp"}`,
      "GET /connectors null",
      `GET /connectors/${connectorId} null`,
      `PATCH /connectors/${connectorId} {"expectedConnectorVersion":1,"displayName":"Orders v2"}`,
      `POST /connectors/${connectorId}/activate {"expectedConnectorVersion":2}`,
      `POST /connectors/${connectorId}/deactivate {"expectedConnectorVersion":1}`,
    ],
  );
  await assert.rejects(connectors.activate(connectorId, {}), TypeError);
  await assert.rejects(connectors.register({ displayName: "" }), TypeError);
});

test("a platform callback token verifies only for its Organization, Connector and lifetime", async () => {
  const { keys, requests } = keySet();
  const options = { keys, organizationId, connectorId };
  const claims = await verifyConnectorCallback(token(), options);
  assert.equal(claims.connectorId, connectorId);
  await verifyConnectorCallback(token(), options);
  assert.deepEqual(requests, [`${baseUrl}/api/v1/connectors/jwks`]);

  const now = Math.floor(Date.now() / 1000);
  const other = generateKeyPairSync("ed25519").privateKey;
  for (const [label, authorization] of [
    ["missing", undefined],
    ["not bearer", "Basic abc"],
    ["other Organization", token({ organizationId: "org_2" })],
    ["other Connector", token({ connectorId: "conn_other" })],
    ["issuer", token({ iss: "someone" })],
    ["audience", token({ aud: "someone" })],
    ["expired", token({ iat: now - 120, exp: now - 60 })],
    ["too long", token({ exp: now + 3600 })],
    ["algorithm", token({}, { alg: "HS256" })],
    ["signature", token({}, {}, other)],
  ])
    await assert.rejects(verifyConnectorCallback(authorization, options), ConnectorAuthError, label);

  // An unknown key does not refetch the keys again within the refresh interval.
  await assert.rejects(verifyConnectorCallback(token({}, { kid: "k2" }), options), ConnectorAuthError);
  await assert.rejects(verifyConnectorCallback(token({}, { kid: "k2" }), options), ConnectorAuthError);
  assert.equal(requests.length, 1);
});

test("the Call Context is read from tools/call metadata and bound to the Organization", () => {
  const context = {
    callId: "op_1",
    sessionId: "session_1",
    organizationId,
    userId: "user_1",
    deadline: "2099-01-01T00:00:00.000Z",
    attempt: 1,
  };
  assert.deepEqual(readConnectorCallContext({ "tidb-link/context": context }, { organizationId }), context);
  for (const meta of [
    undefined,
    {},
    { "tidb-link/context": { ...context, organizationId: "org_2" } },
    { "tidb-link/context": { ...context, attempt: 2 } },
    { "tidb-link/context": { ...context, userId: "" } },
  ])
    assert.throws(() => readConnectorCallContext(meta, { organizationId }), ConnectorAuthError);
});

test("the example HTTP Connector answers MCP requests only with a valid platform token", async () => {
  const { keys } = keySet();
  const seen = [];
  const handler = createConnectorHandler({
    baseUrl,
    organizationId,
    connectorId,
    keys,
    tools: {
      lookup_order: {
        description: "Look up an order",
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
        run: async ({ orderId }, context) => {
          seen.push(context.callId);
          return `order ${orderId} for ${context.userId}`;
        },
      },
    },
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const rpc = (body, authorization = token()) =>
    fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "Bearer a.b.c")).status, 401);
  const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ["lookup_order"]);
  const call = await (
    await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "lookup_order",
        arguments: { orderId: "o1" },
        _meta: {
          "tidb-link/context": {
            callId: "op_1",
            sessionId: "s1",
            organizationId,
            userId: "user_1",
            deadline: "2099-01-01T00:00:00.000Z",
            attempt: 1,
          },
        },
      },
    })
  ).json();
  assert.deepEqual(call.result.content, [{ type: "text", text: "order o1 for user_1" }]);
  const missing = await (
    await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lookup_order", arguments: {} } })
  ).json();
  assert.equal(missing.error.code, -32602);
  assert.deepEqual(seen, ["op_1"]);
});
