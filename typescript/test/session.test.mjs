import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import {
  ConflictError,
  OutcomeUnknownError,
  UserClient,
} from "../dist/index.js";

const servers = [];
const userApiKey = "ti_user_" + "key_" + "x".repeat(43);

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const clientFor = (baseUrl) =>
  new UserClient({
    baseUrl,
    apiKey: userApiKey,
  });

const agent = {
  agentId: "agent_1",
  name: "Agent One",
  sandboxProfile: "default",
  agentTemplateId: null,
  agentTemplate: null,
  config: {
    memory: {
      enabled: false,
      provider: "mem9",
      mem9: { hasKey: false, ownershipState: "admin_not_configured" },
    },
    sessionRecall: { enabled: false },
    generatedMedia: { enabled: true },
  },
  configVersion: 1,
  status: "active",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const sessionRecord = (overrides = {}) => ({
  organizationId: "org_1",
  sessionId: "session_1",
  name: null,
  autoTitle: null,
  ownerUserId: "user_1",
  startedByUserId: "user_1",
  createdByType: "user",
  readOnly: false,
  sourceSchedulerId: null,
  sourceSchedulerFireId: null,
  sourceVoiceSessionId: null,
  billingTag: { key: "customer", value: "acme" },
  model: "gpt-5.6-terra",
  modelRevision: 1,
  createdWithAgentId: "agent_1",
  modelPolicyStatus: "allowed",
  status: "active",
  activeTurnId: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

test("an Agent creates a persistent Session and retains its model ETag", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.setHeader("etag", '"agent-v1"');
      response.end(JSON.stringify({ agent }));
      return;
    }
    response.setHeader("etag", '"session-v1"');
    response.writeHead(201).end(JSON.stringify({ session: sessionRecord() }));
  });
  const remoteAgent = await clientFor(baseUrl).getAgent("agent_1");

  await assert.rejects(remoteAgent.createSession({}), TypeError);
  assert.equal(calls.length, 1);
  const session = await remoteAgent.createSession({
    billingTag: { key: "customer", value: "acme" },
    model: "deployment.model",
    idempotencyKey: "session-1",
  });

  assert.equal(session.id, "session_1");
  assert.equal(session.model, "gpt-5.6-terra");
  assert.deepEqual(JSON.parse(calls[1].body), {
    agentId: "agent_1",
    model: "deployment.model",
    billingTag: { key: "customer", value: "acme" },
  });
  assert.equal(calls[1].headers["idempotency-key"], "session-1");
  assert.equal(calls[1].headers["x-agent9-project-id"], undefined);
  assert.equal(calls[1].headers["x-ti-project-id"], undefined);
});

test("a Session updates the model with its retained ETag and never overwrites a conflict", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.setHeader("etag", '"session-v1"');
      response.end(JSON.stringify({ session: sessionRecord() }));
      return;
    }
    if (calls.length === 2) {
      assert.equal(request.headers["if-match"], '"session-v1"');
      response.setHeader("etag", '"session-v2"');
      response.end(
        JSON.stringify({
          session: sessionRecord({
            model: "claude-sonnet-5",
            modelRevision: 2,
          }),
        }),
      );
      return;
    }
    assert.equal(request.headers["if-match"], '"session-v2"');
    response.writeHead(412).end(
      JSON.stringify({
        error: { code: "precondition_failed", message: "Stale Session" },
      }),
    );
  });
  const session = await clientFor(baseUrl).getSession("session_1");

  await session.setModel("claude-sonnet-5");
  assert.equal(session.model, "claude-sonnet-5");
  await assert.rejects(session.setModel("gpt-5.6-sol"), ConflictError);

  assert.equal(session.model, "claude-sonnet-5");
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url]),
    [
      ["GET", "/api/v1/user/sessions/session_1"],
      ["PATCH", "/api/v1/user/sessions/session_1/model"],
      ["PATCH", "/api/v1/user/sessions/session_1/model"],
    ],
  );
});

test("Session metadata updates keep the independent model token and do not replay uncertain effects", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    if (body.includes("lost")) {
      response.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") response.setHeader("etag", '"model-1"');
    if (request.url.endsWith("/model")) {
      assert.equal(request.headers["if-match"], '"model-1"');
      response.setHeader("etag", '"model-2"');
    }
    response.end(JSON.stringify({ session: sessionRecord() }));
  });
  const session = await clientFor(baseUrl).getSession("session_1");
  await session.rename("Named");
  await session.setBillingTag(null);
  await session.setModel("dynamic-model");
  await assert.rejects(session.rename("lost"), OutcomeUnknownError);
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.slice(1).map((c) => [c.method, c.url]),
    [
      ["POST", "/api/v1/user/sessions/session_1/name"],
      ["PATCH", "/api/v1/user/sessions/session_1/billing-tag"],
      ["PATCH", "/api/v1/user/sessions/session_1/model"],
      ["POST", "/api/v1/user/sessions/session_1/name"],
    ],
  );
});

test("Session creation with exhausted retries preserves the caller key for explicit recovery", async () => {
  let fail = true;
  const identities = [];
  const baseUrl = await serve((req, res) => {
    if (req.method === "GET") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ agent }));
      return;
    }
    identities.push(req.headers["idempotency-key"]);
    if (fail) {
      res.destroy();
      return;
    }
    res
      .writeHead(201, { "content-type": "application/json", etag: '"model-1"' })
      .end(JSON.stringify({ session: sessionRecord() }));
  });
  const remoteAgent = await clientFor(baseUrl).getAgent("agent_1");
  const options = { idempotencyKey: "session-recover" };
  await assert.rejects(remoteAgent.createSession(options), OutcomeUnknownError);
  fail = false;
  assert.equal((await remoteAgent.createSession(options)).id, "session_1");
  assert(identities.every((value) => value === options.idempotencyKey));
});

test("Session suggested naming keeps the model token and reports uncertain naming without replay", async () => {
  let suggests = 0;
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.setHeader("etag", '"model-1"');
      res.end(JSON.stringify({ session: sessionRecord() }));
    } else if (req.url.endsWith("/name/suggest")) {
      suggests++;
      assert.deepEqual(JSON.parse(body), {
        userText: "Help plan",
        assistantText: "A plan",
      });
      if (suggests > 1) {
        res.destroy();
        return;
      }
      res.end(
        JSON.stringify({
          name: "Planning",
          session: sessionRecord({ name: "Planning" }),
        }),
      );
    } else {
      assert.equal(req.headers["if-match"], '"model-1"');
      res.setHeader("etag", '"model-2"');
      res.end(JSON.stringify({ session: sessionRecord() }));
    }
  });
  const session = await clientFor(baseUrl).getSession("session_1");
  const input = { userText: "Help plan", assistantText: "A plan" };
  await session.suggestName(input);
  assert.equal(session.data.name, "Planning");
  await session.setModel("dynamic-model");
  await assert.rejects(session.suggestName(input), OutcomeUnknownError);
  assert.equal(suggests, 2);
});
