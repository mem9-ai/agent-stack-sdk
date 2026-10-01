import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, UserClient } from "../dist/index.js";

const servers = [];
const userApiKey = "ag9_uak_" + "key_" + "x".repeat(32);

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

const agentRecord = (overrides = {}) => ({
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
  ...overrides,
});

const userClient = (baseUrl) => new UserClient({ baseUrl, apiKey: userApiKey });

test("Agent creation retries with stable identities and retains the ETag", async () => {
  const requests = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (requests.length === 1) {
      response
        .writeHead(503)
        .end(
          JSON.stringify({
            error: {
              code: "idempotency_in_progress",
              message: "Still creating",
            },
          }),
        );
      return;
    }
    response.setHeader("etag", '"agent-v1"');
    response
      .writeHead(201)
      .end(
        JSON.stringify({
          agent: agentRecord({ agentTemplateId: "template_1" }),
        }),
      );
  });

  const agent = await userClient(baseUrl).createAgent({
    name: "Agent One",
    agentTemplateId: "template_1",
    templateVersion: 2,
    config: {
      hardware: {
        requirements: [
          {
            definitionId: "hdef_" + "a".repeat(32),
            capabilityNames: ["set_level"],
          },
        ],
      },
    },
    idempotencyKey: "create-agent-1",
  });

  assert.equal(agent.id, "agent_1");
  assert.equal(agent.name, "Agent One");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers["idempotency-key"], "create-agent-1");
  assert.equal(
    requests[0].headers["idempotency-key"],
    requests[1].headers["idempotency-key"],
  );
  assert.equal(
    requests[0].headers["x-request-id"],
    requests[1].headers["x-request-id"],
  );
  assert.equal(requests[0].headers["x-agent9-project-id"], undefined);
  assert.deepEqual(JSON.parse(requests[0].body), {
    name: "Agent One",
    agentTemplateId: "template_1",
    templateVersion: 2,
    config: {
      hardware: {
        requirements: [
          {
            definitionId: "hdef_" + "a".repeat(32),
            capabilityNames: ["set_level"],
          },
        ],
      },
    },
  });
});

test("Agent mutations refresh once when needed and retain each fresh ETag", async () => {
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
      response.end(
        JSON.stringify({
          agent: agentRecord({ name: "Renamed", configVersion: 2 }),
        }),
      );
      return;
    }
    if (request.url === "/api/agents/agent_1/config") {
      assert.equal(request.headers["if-match"], '"agent-v2"');
      response.setHeader("etag", '"agent-v3"');
      response.end(
        JSON.stringify({
          agent: agentRecord({
            name: "Renamed",
            config: {
              ...agentRecord().config,
              sessionRecall: { enabled: true },
            },
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
  await agent.configure({ sessionRecall: { enabled: true } });
  assert.deepEqual(agent.config.sessionRecall, { enabled: true });
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
    response
      .writeHead(412)
      .end(
        JSON.stringify({
          error: { code: "precondition_failed", message: "Stale Agent" },
        }),
      );
  });
  const agent = await userClient(baseUrl).getAgent("agent_1");

  await assert.rejects(agent.rename("Lost update"), ConflictError);

  assert.equal(agent.name, "Agent One");
  assert.deepEqual(calls, [
    "GET /api/agents/agent_1",
    "PATCH /api/agents/agent_1/name",
  ]);
});

test("the User client exposes real default Agents and read-only AgentTemplates", async () => {
  const calls = [];
  const template = {
    agentTemplateId: "template_1",
    organizationId: "org_1",
    name: "Support",
    sandboxProfile: "default",
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
    response.end(JSON.stringify({ agentTemplates: [template] }));
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

test("Memory provisioning, retained state, and creator credential operations use the canonical contract", async () => {
  const calls = [];
  let configVersion = 1;
  const memoryAgent = (enabled = true) =>
    agentRecord({
      configVersion,
      config: {
        ...agentRecord().config,
        memory: {
          enabled,
          provider: "mem9",
          mem9: { hasKey: true, ownershipState: "claimed" },
        },
      },
    });
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agents") {
      response.setHeader("etag", `"agent-v${configVersion}"`);
      response.writeHead(201).end(JSON.stringify({ agent: memoryAgent() }));
      return;
    }
    if (request.url === "/api/agents/memory/mem9/key-validations") {
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ valid: true }));
      return;
    }
    if (
      request.url === "/api/agents/agent_1/memory/mem9/key" &&
      request.method === "GET"
    ) {
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ mem9Key: "test-memory-key" }));
      return;
    }
    if (
      request.url === "/api/agents/agent_1/memory/mem9/key" &&
      request.method === "PUT"
    ) {
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ agent: memoryAgent() }));
      return;
    }
    if (request.url === "/api/agents/agent_1" && request.method === "GET") {
      response.setHeader("etag", `"agent-v${configVersion}"`);
      response.end(JSON.stringify({ agent: memoryAgent() }));
      return;
    }
    configVersion += 1;
    response.setHeader("etag", `"agent-v${configVersion}"`);
    response.end(
      JSON.stringify({
        agent: memoryAgent(JSON.parse(body).memory.enabled),
      }),
    );
  });
  const client = userClient(baseUrl);

  const agent = await client.createAgent({
    agentTemplateId: "template_1",
    config: { memory: { enabled: true } },
    memoryCredential: { mode: "provision" },
  });
  await client.createAgent({
    agentTemplateId: "template_1",
    config: { memory: { enabled: true } },
    memoryCredential: { mode: "use_existing", mem9Key: "test-memory-key" },
  });
  assert.deepEqual(await client.validateMemoryKey("test-memory-key"), {
    valid: true,
  });
  assert.equal(await agent.revealMemoryKey(), "test-memory-key");
  await agent.replaceMemoryKey("replacement-memory-key");
  await agent.configure({ memory: { enabled: false } });
  await agent.configure({ memory: { enabled: true } });

  assert.equal(agent.config.memory.enabled, true);
  assert.equal(agent.config.memory.mem9.hasKey, true);
  assert.equal("mem9Key" in agent.config.memory.mem9, false);
  assert.deepEqual(JSON.parse(calls[0].body), {
    agentTemplateId: "template_1",
    config: { memory: { enabled: true } },
    memoryCredential: { mode: "provision" },
  });
  assert.deepEqual(JSON.parse(calls[1].body), {
    agentTemplateId: "template_1",
    config: { memory: { enabled: true } },
    memoryCredential: { mode: "use_existing", mem9Key: "test-memory-key" },
  });
  assert.deepEqual(JSON.parse(calls[2].body), { mem9Key: "test-memory-key" });
  assert.deepEqual(JSON.parse(calls[4].body), {
    mem9Key: "replacement-memory-key",
  });
  assert.deepEqual(JSON.parse(calls[6].body), { memory: { enabled: false } });
  assert.deepEqual(JSON.parse(calls[7].body), { memory: { enabled: true } });
});

test("a User client rejects Organization authority without exposing it", () => {
  const organizationKey = "ag9_oak." + "key_id." + "x".repeat(32);
  assert.throws(
    () =>
      new UserClient({
        baseUrl: "https://agent.example.com",
        apiKey: organizationKey,
      }),
    (error) => !String(error).includes(organizationKey),
  );
  assert.throws(
    () =>
      new UserClient({
        baseUrl: "https://agent.example.com",
        apiKey: userApiKey,
        projectId: "project_1",
      }),
    /projectId is not supported/,
  );
});

test("removed Agent fields are rejected before a request", async () => {
  let requests = 0;
  const baseUrl = await serve((_request, response) => {
    requests += 1;
    response.writeHead(500).end();
  });
  const client = userClient(baseUrl);

  await assert.rejects(
    client.createAgent({
      agentTemplateId: "template_1",
      config: { runtime: { backend: "codex" } },
    }),
    /Agent config.runtime is not supported/,
  );
  await assert.rejects(
    client.createAgent({
      agentTemplateId: "template_1",
      config: { memory: { enabled: true, provider: "mem9" } },
    }),
    /Agent config.memory.provider is not supported/,
  );
  await assert.rejects(
    client.createAgent({ model: "gpt-5.6-sol" }),
    /Agent creation.model is not supported/,
  );
  assert.equal(requests, 0);
});

test("published hardware content and explicit application preserve empty overrides on the wire", async () => {
  const calls = [];
  const ref = {
    templateId: "template_1",
    version: 2,
    contentDigest: "a".repeat(64),
  };
  const baseUrl = await serve(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({
      path: request.url,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : null,
    });
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", '"agent-v2"');
    if (request.url === "/api/agents/template-versions/template_1/2")
      return response.end(
        JSON.stringify({
          agentTemplateId: "template_1",
          templateVersion: 2,
          contentDigest: ref.contentDigest,
          content: {
            schemaVersion: "agent-template-content@2",
            hardware: { requirements: [] },
          },
          availability: "available",
        }),
      );
    if (request.url.endsWith("template-application-previews"))
      return response.end(
        JSON.stringify({
          targetRef: ref,
          nextOverrides: { hardware: { requirements: [] } },
        }),
      );
    response.end(
      JSON.stringify({
        agent: agentRecord({
          templateApplication: {
            ...ref,
            overrides: { hardware: { requirements: [] } },
          },
          config: { hardware: { requirements: [] } },
        }),
      }),
    );
  });
  const user = userClient(baseUrl),
    version = await user.getPublishedTemplateVersion("template_1", 2);
  assert.equal(version.content.schemaVersion, "agent-template-content@2");
  assert.deepEqual(version.content.hardware.requirements, []);
  const agent = await user.getAgent("agent_1");
  const body = {
    agentTemplateId: "template_1",
    templateVersion: 2,
    expectedApplication: null,
    adoption: true,
    resetOverridePaths: ["hardware.requirements"],
    overrides: { hardware: { requirements: [] } },
  };
  assert.deepEqual(
    (await agent.previewTemplateApplication(body)).nextOverrides,
    { hardware: { requirements: [] } },
  );
  await agent.applyTemplate(body, { idempotencyKey: "apply-hardware-2" });
  assert.deepEqual(calls.at(-1).body, body);
  assert.equal(calls.at(-1).headers["if-match"], '"agent-v2"');
  assert.equal(calls.at(-1).headers["idempotency-key"], "apply-hardware-2");
  assert.deepEqual(agent.config.hardware, { requirements: [] });
  await agent.configure({ hardware: { requirements: [] } });
  assert.deepEqual(calls.at(-1).body, { hardware: { requirements: [] } });
});
