import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, OutcomeUnknownError, TiDBLinkApiError, UserClient } from "../dist/index.js";

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
  organizationId: "org_1",
  ownerUserId: "user_1",
  agentTemplateId: "template_1",
  status: "active",
  createdAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
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
  template: { templateId: "template_1", version: 2, contentDigest: "a".repeat(64) },
  modelPolicyStatus: "allowed",
  status: "active",
  activeTurnId: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

test("the fixed Session lifecycle supports list, read, display metadata and deletion", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/agents/agent_1") return response.end(JSON.stringify({ agent }));
    if (request.url === "/api/v1/sessions" && request.method === "GET") return response.end(JSON.stringify({ sessions: [sessionRecord()] }));
    const updates = request.url.endsWith("/name") ? { name: JSON.parse(body).name } : request.url.endsWith("/billing-tag") ? { billingTag: JSON.parse(body).billingTag } : request.method === "DELETE" ? { status: "deleted" } : {};
    response.end(JSON.stringify({ session: sessionRecord(updates) }));
  });
  const user = clientFor(baseUrl);
  const remoteAgent = await user.getAgent("agent_1");
  await assert.rejects(remoteAgent.createSession({ model: "gpt-5.6-sol" }), /model is not supported/);
  const session = await remoteAgent.createSession({ idempotencyKey: "metadata-session", billingTag: { key: "customer", value: "acme" } });
  assert.equal(session.id, "session_1");
  assert.equal(session.model, "gpt-5.6-terra");
  assert.deepEqual(session.data.template, { templateId: "template_1", version: 2, contentDigest: "a".repeat(64) });
  assert.equal(session.setModel, undefined);
  assert.deepEqual((await user.listSessions()).map(session => session.data), [sessionRecord()]);
  await session.refresh();
  await session.rename("Customer conversation");
  assert.equal(session.data.name, "Customer conversation");
  await session.setBillingTag(null);
  assert.equal(session.data.billingTag, null);
  await session.delete();
  assert.equal(session.data.status, "deleted");
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ["GET", "/api/v1/agents/agent_1"], ["POST", "/api/v1/sessions"], ["GET", "/api/v1/sessions"], ["GET", "/api/v1/sessions/session_1"],
    ["POST", "/api/v1/sessions/session_1/name"], ["PATCH", "/api/v1/sessions/session_1/billing-tag"], ["DELETE", "/api/v1/sessions/session_1"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), { agentId: "agent_1", billingTag: { key: "customer", value: "acme" } });
});

test("an uncertain Session creation preserves the caller's key for explicit recovery", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : null });
    if (request.method === "GET") return response.end(JSON.stringify({ agent }));
    if (calls.length === 2) return request.socket.destroy();
    response.setHeader("content-type", "application/json");
    if (JSON.parse(raw).billingTag) return response.writeHead(409).end(JSON.stringify({ error: { code: "session_creation_conflict", message: "Key reused with a different request" } }));
    response.writeHead(201).end(JSON.stringify({ session: sessionRecord() }));
  });
  const remoteAgent = await clientFor(baseUrl).getAgent("agent_1");
  const options = { idempotencyKey: "session-creation:001" };
  await assert.rejects(remoteAgent.createSession(options), error => {
    assert(error instanceof OutcomeUnknownError);
    assert.equal(error.idempotencyKey, options.idempotencyKey);
    return true;
  });
  assert.equal(calls.length, 2);
  const recovered = await remoteAgent.createSession(options);
  assert.equal(recovered.id, "session_1");
  assert.equal(recovered.data.template.version, 2);
  await assert.rejects(remoteAgent.createSession({ ...options, billingTag: { key: "customer", value: "changed" } }), error => error instanceof ConflictError && error.code === "session_creation_conflict");
  for (const call of calls.slice(1)) {
    assert.equal(call.headers["idempotency-key"], options.idempotencyKey);
    for (const key of ["cookie", "x-ti-user-id", "x-ti-organization-id"]) assert.equal(call.headers[key], undefined);
  }
  assert.deepEqual(calls.slice(1, 3).map(call => call.body), [{ agentId: "agent_1" }, { agentId: "agent_1" }]);
  for (const idempotencyKey of [undefined, "", "bad/key", "a".repeat(129), "_wrong", "a\n", "a\r", 42]) await assert.rejects(remoteAgent.createSession({ idempotencyKey }), /idempotencyKey/);
  const controller = new AbortController(); controller.abort(new Error("before dispatch"));
  await assert.rejects(remoteAgent.createSession({ ...options, signal: controller.signal }), /before dispatch/);
  assert.equal(calls.length, 4);
});

test("saved interactions page by sequence and link original inputs to ordered Turn content", async () => {
  const timestamp = "2026-10-04T00:00:00Z";
  const records = [
    { inputId: "start-001", sequence: 1, kind: "message", mode: "started", turnId: "turn_1", message: { id: "message_1", role: "user", content: "Hello", createdAt: timestamp }, createdAt: timestamp, appliedAt: timestamp, rejection: null, result: { status: "succeeded", completedAt: timestamp } },
    { inputId: "steer-001", sequence: 2, kind: "message", mode: "steered", turnId: "turn_1", message: { id: "message_2", role: "user", content: "Add details", createdAt: timestamp }, createdAt: timestamp, appliedAt: null, rejection: null, result: { status: "failed", completedAt: timestamp } },
    { inputId: "cancel-001", sequence: 3, kind: "cancel", mode: "cancelled", turnId: "turn_2", message: null, createdAt: timestamp, appliedAt: null, rejection: null, result: { status: "interrupted", completedAt: timestamp } },
    { inputId: "refused-001", sequence: 4, kind: "message", mode: "rejected", turnId: "turn_3", message: null, createdAt: timestamp, appliedAt: null, rejection: { code: "interaction_admission_closed" }, result: { status: "running", completedAt: null } },
  ];
  const turn = { id: "turn_1", sessionId: "session_1", status: "succeeded", billingTag: null, userMessage: { ...records[0].message, sessionId: "session_1", turnId: "turn_1" }, userMessages: records.slice(0, 2).map(record => ({ ...record.message, sessionId: "session_1", turnId: "turn_1" })), operations: [{ id: "operation_1", status: "succeeded" }], assistantMessage: { id: "assistant_1", role: "assistant", content: "Done", sessionId: "session_1", turnId: "turn_1", createdAt: timestamp }, createdAt: timestamp };
  const urls = [];
  const baseUrl = await serve((request, response) => {
    urls.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("/turns/turn_1")) return response.end(JSON.stringify({ turn }));
    if (request.url.endsWith("/interactions/cancel-001")) return response.end(JSON.stringify({ interaction: records[2] }));
    if (request.url.includes("/interactions/missing")) return response.writeHead(404).end(JSON.stringify({ error: { code: "interaction_not_found", message: "Missing" } }));
    const cursor = new URL(request.url, "http://fixture").searchParams.get("cursor");
    const offset = cursor ? Number(cursor.slice(5)) : 0;
    response.end(JSON.stringify({ interactions: [records[offset]], hasMore: offset < 3, nextCursor: offset < 3 ? "page/" + (offset + 1) : null }));
  });
  const session = clientFor(baseUrl).session("session_1");
  const received = []; let cursor;
  do {
    const page = await session.listInteractions({ limit: 1, ...(cursor ? { cursor } : {}) });
    received.push(...page.interactions); cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(received, records);
  assert.deepEqual(await session.getInteraction("cancel-001"), records[2]);
  assert.deepEqual(await session.getTurn("turn_1"), turn);
  await assert.rejects(session.getInteraction("missing"), error => error instanceof TiDBLinkApiError && error.code === "interaction_not_found");
  assert.deepEqual(urls.slice(0, 4), ["/api/v1/sessions/session_1/interactions?limit=1", "/api/v1/sessions/session_1/interactions?limit=1&cursor=page%2F1", "/api/v1/sessions/session_1/interactions?limit=1&cursor=page%2F2", "/api/v1/sessions/session_1/interactions?limit=1&cursor=page%2F3"]);
});
