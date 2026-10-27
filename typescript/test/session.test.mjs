import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, OutcomeUnknownError, UserClient } from "../dist/index.js";

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
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
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

  await assert.rejects(
    remoteAgent.createSession({ model: "gpt-5.6-sol" }),
    /Session options.model is not supported/,
  );
  assert.equal(calls.length, 1);
  const session = await remoteAgent.createSession({
    billingTag: { key: "customer", value: "acme" },
  });

  assert.equal(session.id, "session_1");
  assert.equal(session.model, "gpt-5.6-terra");
  assert.deepEqual(JSON.parse(calls[1].body), {
    agentId: "agent_1",
    billingTag: { key: "customer", value: "acme" },
  });
  assert.equal(calls[1].headers["idempotency-key"], undefined);
  assert.equal(calls[1].headers["x-agent9-project-id"], undefined);
  assert.equal(calls[1].headers["x-ti-project-id"], undefined);
});

test("a Session updates the model with its retained ETag and never overwrites a conflict", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
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
          session: sessionRecord({ model: "claude-sonnet-5", modelRevision: 2 }),
        }),
      );
      return;
    }
    assert.equal(request.headers["if-match"], '"session-v2"');
    response.writeHead(412).end(
      JSON.stringify({ error: { code: "precondition_failed", message: "Stale Session" } }),
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
      ["GET", "/api/sessions/session_1"],
      ["PATCH", "/api/sessions/session_1/model"],
      ["PATCH", "/api/sessions/session_1/model"],
    ],
  );
});

test("a reconstructed Session reads ordered history and one known Turn", async () => {
  const turn = {
    id: "turn_1",
    sessionId: "session_1",
    status: "succeeded",
    billingTag: null,
    userMessage: {
      id: "message_1",
      sessionId: "session_1",
      turnId: "turn_1",
      role: "user",
      content: "Hello",
      createdAt: "2026-08-25T00:00:00.000Z",
    },
    operations: [],
    assistantMessage: {
      id: "message_2",
      sessionId: "session_1",
      turnId: "turn_1",
      role: "assistant",
      content: "Hi",
      createdAt: "2026-08-25T00:00:01.000Z",
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:00:01.000Z",
  };
  const baseUrl = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      request.url?.endsWith("/turn_1")
        ? JSON.stringify({ turn })
        : JSON.stringify({ turns: [turn] }),
    );
  });
  const session = clientFor(baseUrl).session("session_1");

  assert.deepEqual(await session.history(), [turn]);
  assert.deepEqual(await session.getTurn("turn_1"), turn);
});

test("a lost Session creation response is outcome unknown and is not retried", async () => {
  let creates = 0;
  const baseUrl = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.setHeader("etag", '"agent-v1"');
      response.end(JSON.stringify({ agent }));
      return;
    }
    creates += 1;
    request.socket.destroy();
  });
  const remoteAgent = await clientFor(baseUrl).getAgent("agent_1");

  await assert.rejects(remoteAgent.createSession(), OutcomeUnknownError);
  assert.equal(creates, 1);
});
