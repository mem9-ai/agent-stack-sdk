import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, UserClient } from "../dist/index.js";

const servers = [];
const userApiKey = "ag9_uak_" + "key_" + "x".repeat(32);

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

const agentRecord = (overrides = {}) => ({
  agentId: "agent_1",
  workspaceId: "workspace_1",
  name: "Agent One",
  sandboxProfile: "default",
  e2bTemplate: "default",
  model: "gpt-5.6-terra",
  modelPolicyStatus: "allowed",
  agentTemplateId: null,
  agentDefinitionId: null,
  agentTemplate: null,
  config: {},
  configVersion: 1,
  status: "active",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  ...overrides,
});

const userClient = (baseUrl) =>
  new UserClient({
    baseUrl,
    apiKey: userApiKey,
    projectId: "project_1",
  });

test("Agent creation retries with stable identities and retains the ETag", async () => {
  const requests = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (requests.length === 1) {
      response.writeHead(503).end(
        JSON.stringify({ error: { code: "idempotency_in_progress", message: "Still creating" } }),
      );
      return;
    }
    response.setHeader("etag", '"agent-v1"');
    response.writeHead(201).end(
      JSON.stringify({ agent: agentRecord({ agentTemplateId: "template_1" }) }),
    );
  });

  const agent = await userClient(baseUrl).createAgent({
    name: "Agent One",
    agentTemplateId: "template_1",
    idempotencyKey: "create-agent-1",
  });

  assert.equal(agent.id, "agent_1");
  assert.equal(agent.name, "Agent One");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["idempotency-key"], "create-agent-1");
  assert.equal(requests[0].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
  assert.equal(requests[0].headers["x-request-id"], requests[1].headers["x-request-id"]);
  assert.equal(requests[0].headers["x-agent9-project-id"], "project_1");
  assert.deepEqual(JSON.parse(requests[0].body), {
    name: "Agent One",
    agentTemplateId: "template_1",
  });
});

test("Agent mutations refresh once when needed and retain each fresh ETag", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agents" && request.method === "GET") {
      response.end(JSON.stringify({ agents: [agentRecord()] }));
      return;
    }
    if (request.url === "/api/agents/agent_1" && request.method === "GET") {
      response.setHeader("etag", '"agent-v1"');
      response.end(JSON.stringify({ agent: agentRecord() }));
      return;
    }
    if (request.url === "/api/agents/agent_1/name") {
      assert.equal(request.headers["if-match"], '"agent-v1"');
      response.setHeader("etag", '"agent-v2"');
      response.end(JSON.stringify({ agent: agentRecord({ name: "Renamed", configVersion: 2 }) }));
      return;
    }
    if (request.url === "/api/agents/agent_1/config") {
      assert.equal(request.headers["if-match"], '"agent-v2"');
      response.setHeader("etag", '"agent-v3"');
      response.end(
        JSON.stringify({
          agent: agentRecord({
            name: "Renamed",
            config: { delegation: { enabled: true } },
            configVersion: 3,
          }),
        }),
      );
      return;
    }
    assert.equal(request.headers["if-match"], '"agent-v3"');
    response.writeHead(204).end();
  });
  const client = userClient(baseUrl);
  const [agent] = await client.listAgents();

  await agent.rename("Renamed");
  assert.equal(agent.name, "Renamed");
  await agent.configure({ delegation: { enabled: true } });
  assert.deepEqual(agent.config, { delegation: { enabled: true } });
  await agent.archive();
  assert.equal(agent.status, "archived");

  assert.deepEqual(
    calls.map(({ method, url }) => [method, url]),
    [
      ["GET", "/api/agents"],
      ["GET", "/api/agents/agent_1"],
      ["PATCH", "/api/agents/agent_1/name"],
      ["PATCH", "/api/agents/agent_1/config"],
      ["POST", "/api/agents/agent_1/archive"],
    ],
  );
});

test("a stale Agent mutation fails without an automatic overwrite", async () => {
  const calls = [];
  const baseUrl = await serve((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.setHeader("etag", '"agent-v1"');
      response.end(JSON.stringify({ agent: agentRecord() }));
      return;
    }
    response.writeHead(412).end(
      JSON.stringify({ error: { code: "precondition_failed", message: "Stale Agent" } }),
    );
  });
  const agent = await userClient(baseUrl).getAgent("agent_1");

  await assert.rejects(agent.rename("Lost update"), ConflictError);

  assert.equal(agent.name, "Agent One");
  assert.deepEqual(calls, ["GET /api/agents/agent_1", "PATCH /api/agents/agent_1/name"]);
});

test("the User client exposes real default Agents and read-only AgentTemplates", async () => {
  const calls = [];
  const template = {
    agentTemplateId: "template_1",
    agentDefinitionId: "template_1",
    workspaceId: "workspace_1",
    name: "Support",
    sandboxProfile: "default",
    e2bTemplate: "default",
    model: "gpt-5.6-terra",
    status: "active",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agents/default/ensure") {
      response.setHeader("etag", '"agent-v1"');
      response.writeHead(201).end(JSON.stringify({ agent: agentRecord() }));
      return;
    }
    if (request.url === "/api/agents/default") {
      response.end(JSON.stringify({ defaultAgentId: "agent_1" }));
      return;
    }
    response.end(
      JSON.stringify({ agentTemplates: [template], agentDefinitions: [{ name: "deprecated" }] }),
    );
  });
  const client = userClient(baseUrl);

  const agent = await client.getOrCreateDefaultAgent();
  await agent.makeDefault();
  assert.deepEqual(await client.listAgentTemplates(), [template]);

  assert.deepEqual(
    calls.map(({ method, url }) => [method, url]),
    [
      ["POST", "/api/agents/default/ensure"],
      ["PUT", "/api/agents/default"],
      ["GET", "/api/console/model"],
    ],
  );
  assert.deepEqual(JSON.parse(calls[1].body), { agentId: "agent_1" });
});

test("a User client rejects Workspace authority and an invalid Project", () => {
  const workspaceKey = "ag9_wak." + "key_id." + "x".repeat(32);
  assert.throws(
    () => new UserClient({ baseUrl: "https://agent.example.com", apiKey: workspaceKey, projectId: "p" }),
    (error) => !String(error).includes(workspaceKey),
  );
  assert.throws(
    () =>
      new UserClient({
        baseUrl: "https://agent.example.com",
        apiKey: userApiKey,
        projectId: "INVALID PROJECT",
      }),
    /projectId/,
  );
});
