import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, UserClient } from "../dist/index.js";

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

const agentRecord = { agentId: "agent_1", organizationId: "org_1", ownerUserId: "busr_1", agentTemplateId: "template_1", status: "active", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" };
const userClient = baseUrl => new UserClient({ baseUrl, apiKey: userApiKey });

test("published Template selection creates and reads one Agent association, then unlinks it", async () => {
  const calls = [];
  const summary = { agentTemplateId: "template_1", displayName: "Support", description: "Customer support", latestPublishedVersion: 2 };
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/api/v1/agent-templates")) return response.end(JSON.stringify({ templates: [summary], hasMore: true, nextCursor: "next-page" }));
    if (request.method === "DELETE") return response.writeHead(204).end();
    if (request.method === "GET" && request.url === "/api/v1/agents") return response.end(JSON.stringify({ agents: [agentRecord] }));
    if (request.method === "POST" && calls.filter(call => call.method === "POST").length === 1) return response.writeHead(503).end(JSON.stringify({ error: { code: "service_unavailable", message: "Try later" } }));
    response.end(JSON.stringify({ agent: agentRecord }));
  });
  const user = userClient(baseUrl);
  assert.deepEqual(await user.listAgentTemplates({ limit: 1, cursor: "previous/page" }), { templates: [summary], hasMore: true, nextCursor: "next-page" });
  const agent = await user.createAgent({ agentTemplateId: "template_1" });
  assert.deepEqual(agent.data, agentRecord);
  assert.deepEqual((await user.listAgents()).map(agent => agent.data), [agentRecord]);
  assert.deepEqual((await user.getAgent("agent_1")).data, agentRecord);
  await agent.unlink();
  const creates = calls.filter(call => call.method === "POST");
  assert.equal(creates.length, 2);
  assert.equal(creates[0].headers["x-request-id"], creates[1].headers["x-request-id"]);
  assert.deepEqual(creates.map(call => JSON.parse(call.body)), [{ agentTemplateId: "template_1" }, { agentTemplateId: "template_1" }]);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ["GET", "/api/v1/agent-templates?limit=1&cursor=previous%2Fpage"], ["POST", "/api/v1/agents"], ["POST", "/api/v1/agents"],
    ["GET", "/api/v1/agents"], ["GET", "/api/v1/agents/agent_1"], ["DELETE", "/api/v1/agents/agent_1"],
  ]);
  for (const { headers } of calls) {
    assert.equal(headers.authorization, "Bearer " + userApiKey);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers["x-ti-user-id"], undefined);
  }
});

test("removed Agent behavior and selection fields fail before HTTP dispatch", async () => {
  let requests = 0;
  const baseUrl = await serve((_request, response) => { requests += 1; response.writeHead(500).end(); });
  const user = userClient(baseUrl);
  for (const field of ["name", "config", "templateVersion", "overrides", "model", "memoryCredential", "idempotencyKey"]) {
    await assert.rejects(user.createAgent({ agentTemplateId: "template_1", [field]: {} }), new RegExp(field + " is not supported"));
  }
  await assert.rejects(user.createAgent({}), /explicit published Template ID/);
  assert.equal(requests, 0);
  for (const method of ["getPublishedTemplateVersion", "getOrCreateDefaultAgent"]) assert.equal(user[method], undefined);
});

test("retained private Memory credential operations use User Key authority", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (request.url.endsWith("key-validations")) return response.end(JSON.stringify({ valid: true }));
    if (request.url.endsWith("/key") && request.method === "GET") return response.end(JSON.stringify({ mem9Key: "test-memory-key" }));
    response.end(JSON.stringify({ agent: agentRecord }));
  });
  const user = userClient(baseUrl);
  const agent = await user.getAgent("agent_1");
  assert.deepEqual(await user.validateMemoryKey("test-memory-key"), { valid: true });
  assert.equal(await agent.revealMemoryKey(), "test-memory-key");
  await agent.replaceMemoryKey("replacement-memory-key");
  assert.deepEqual(agent.data, agentRecord);
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ["GET", "/api/v1/agents/agent_1"], ["POST", "/api/v1/agents/memory/mem9/key-validations"],
    ["GET", "/api/v1/agents/agent_1/memory/mem9/key"], ["PUT", "/api/v1/agents/agent_1/memory/mem9/key"],
  ]);
  assert.deepEqual(JSON.parse(calls.at(-1).body), { mem9Key: "replacement-memory-key" });
  for (const method of ["configure", "rename", "archive", "applyTemplate", "previewTemplateApplication", "makeDefault"]) assert.equal(agent[method], undefined);
});
