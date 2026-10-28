import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { OutcomeUnknownError, UserClient } from "../dist/index.js";

const key = "ti_user_key_" + "x".repeat(43);
const servers = [];
after(async () =>
  Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  ),
);
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const record = {
  agentId: "agent_1",
  organizationId: "org_1",
  ownerUserId: "user_1",
  agentTemplateId: "template_1",
  status: "active",
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};

test("Agent creation recovers through the caller's stable identity without an Agent ETag", async () => {
  const calls = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (calls.length === 1) {
      res.destroy();
      return;
    }
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ agent: record }));
  });
  const user = new UserClient({ baseUrl, apiKey: key });
  const agent = await user.createAgent({
    agentTemplateId: "template_1",
    idempotencyKey: "create-agent-1",
  });
  assert.equal(agent.id, "agent_1");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].headers["x-request-id"],
    calls[1].headers["x-request-id"],
  );
  for (const call of calls) {
    assert.equal(call.url, "/api/v1/user/agents");
    assert.equal(call.headers["idempotency-key"], "create-agent-1");
    assert.deepEqual(call.body, { agentTemplateId: "template_1" });
  }
});

test("exhausted Agent creation remains recoverable with the caller's key", async () => {
  let fail = true;
  const identities = [];
  const baseUrl = await serve((req, res) => {
    identities.push(req.headers["idempotency-key"]);
    if (fail) {
      res.destroy();
      return;
    }
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ agent: record }));
  });
  const user = new UserClient({ baseUrl, apiKey: key });
  const input = { agentTemplateId: "template_1", idempotencyKey: "recover-1" };
  await assert.rejects(user.createAgent(input), OutcomeUnknownError);
  fail = false;
  assert.equal((await user.createAgent(input)).id, "agent_1");
  assert(identities.every((value) => value === input.idempotencyKey));
});

test("owner preferences use a partial last-write-wins update and never replay an uncertain write", async () => {
  const calls = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    if (body.includes("lost")) {
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        agent: {
          ...record,
          additionalInstructions: req.method === "PATCH" ? "Concise" : "",
        },
      }),
    );
  });
  const user = new UserClient({ baseUrl, apiKey: key });
  const agent = await user.getAgent("agent_1");
  await agent.update({ additionalInstructions: "Concise" });
  assert.equal(agent.data.additionalInstructions, "Concise");
  await assert.rejects(
    agent.update({ additionalInstructions: "lost" }),
    OutcomeUnknownError,
  );
  assert.equal(calls.length, 3);
  assert.equal(agent.data.additionalInstructions, "Concise");
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["GET", "/api/v1/user/agents/agent_1"],
      ["PATCH", "/api/v1/user/agents/agent_1"],
      ["PATCH", "/api/v1/user/agents/agent_1"],
    ],
  );
  assert(calls.every((c) => c.headers["if-match"] === undefined));
});

test("Template discovery preserves empty continuation pages and model discovery accepts dynamic IDs", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify(
        req.url.startsWith("/api/v1/agent-models")
          ? {
              models: [
                {
                  model: "future.model-1",
                  label: "Future",
                  availability: "available",
                },
              ],
              effectiveDefaultModel: "future.model-1",
            }
          : { templates: [], hasMore: true, nextCursor: "opaque+/=" },
      ),
    );
  });
  const user = new UserClient({ baseUrl, apiKey: key });
  assert.deepEqual(
    await user.listAgentTemplates({ limit: 1, cursor: "opaque+/=" }),
    { templates: [], hasMore: true, nextCursor: "opaque+/=" },
  );
  assert.equal(
    (await user.listModels({ agentId: "agent/a" })).models[0].model,
    "future.model-1",
  );
  assert.deepEqual(urls, [
    "/api/v1/user/agent-templates?limit=1&cursor=opaque%2B%2F%3D",
    "/api/v1/agent-models?agentId=agent%2Fa",
  ]);
});

test("retired creation selectors, missing identities and wrong authority fail before dispatch without exposing credentials", async () => {
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    res.end("{}");
  });
  const user = new UserClient({ baseUrl, apiKey: key });
  for (const input of [
    { agentTemplateId: "t" },
    { agentTemplateId: "t", idempotencyKey: "bad key" },
    { agentTemplateId: "t", idempotencyKey: "ok", templateVersion: 1 },
    {
      agentTemplateId: "t",
      idempotencyKey: "ok",
      memoryCredential: { mode: "provision" },
    },
  ])
    await assert.rejects(user.createAgent(input), TypeError);
  assert.throws(
    () => new UserClient({ baseUrl, apiKey: "ti_org_key_" + "s".repeat(43) }),
    (error) =>
      error instanceof TypeError && !String(error).includes("s".repeat(43)),
  );
  assert.throws(
    () => new UserClient({ baseUrl, apiKey: "ag9_uak.key." + "s".repeat(32) }),
    TypeError,
  );
  assert.throws(
    () => new UserClient({ baseUrl, apiKey: key, userId: "other" }),
    TypeError,
  );
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(user), "{}");
});

test("aborting creation after dispatch reports an unknown outcome and keeps the replay identity", async () => {
  const controller = new AbortController();
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    res
      .writeHead(503, { "content-type": "application/json" })
      .end(
        JSON.stringify({ error: { code: "unavailable", message: "Unknown" } }),
      );
    setTimeout(() => controller.abort(), 20);
  });
  await assert.rejects(
    new UserClient({ baseUrl, apiKey: key }).createAgent({
      agentTemplateId: "template_1",
      idempotencyKey: "abort-recover",
      signal: controller.signal,
    }),
    OutcomeUnknownError,
  );
  assert.equal(calls, 1);
});
