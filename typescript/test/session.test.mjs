import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { UserClient } from "../dist/index.js";

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
  const session = await remoteAgent.createSession({ billingTag: { key: "customer", value: "acme" } });
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
