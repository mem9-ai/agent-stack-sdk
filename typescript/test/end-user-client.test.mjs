import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { OrganizationClient, OutcomeUnknownError } from "../dist/index.js";

const key = "ti_org_key_" + "x".repeat(43);
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
const created = (res) =>
  res
    .writeHead(201, { "content-type": "application/json", etag: '"model-1"' })
    .end(JSON.stringify({ session: { sessionId: "session_1" } }));

test("Session creation recovers through the caller's stable identity", async () => {
  const calls = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    if (calls.length === 1) {
      res.destroy();
      return;
    }
    created(res);
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  const session = await user.createSession({
    templateId: "template_1",
    idempotencyKey: "create-session-1",
  });
  assert.equal(session.id, "session_1");
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].headers["x-request-id"],
    calls[1].headers["x-request-id"],
  );
  for (const call of calls) {
    assert.equal(call.url, "/api/v1/org/users/user_1/sessions");
    assert.equal(call.headers["idempotency-key"], "create-session-1");
    assert.deepEqual(call.body, { agentTemplateId: "template_1" });
  }
});

test("exhausted Session creation remains recoverable with the caller's key", async () => {
  let fail = true;
  const identities = [];
  const baseUrl = await serve((req, res) => {
    identities.push(req.headers["idempotency-key"]);
    if (fail) {
      res.destroy();
      return;
    }
    created(res);
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  const input = { templateId: "template_1", idempotencyKey: "recover-1" };
  await assert.rejects(user.createSession(input), OutcomeUnknownError);
  fail = false;
  assert.equal((await user.createSession(input)).id, "session_1");
  assert(identities.every((value) => value === input.idempotencyKey));
});

test("Session creation sends the Session options that replaced Agent preferences", async () => {
  const bodies = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    created(res);
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  await user.createSession({
    templateId: "template_1",
    idempotencyKey: "options-1",
    additionalInstructions: "Use metric units.",
    sandbox: { profileId: null, workingDirectory: "work" },
    acknowledgeSessionRecall: true,
    realtimeModel: "voice-a",
  });
  assert.deepEqual(bodies, [
    {
      agentTemplateId: "template_1",
      additionalInstructions: "Use metric units.",
      sandbox: { profileId: null, workingDirectory: "work" },
      acknowledgeSessionRecall: true,
      realtimeModel: "voice-a",
    },
  ]);
});

test("Session creation sends explicit nulls and reports a receipt without a model ETag as unknown", async () => {
  const bodies = [];
  let etag = true;
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    if (etag) return created(res);
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ session: { sessionId: "session_1" } }));
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  const input = {
    templateId: "template_1",
    idempotencyKey: "nulls-1",
    additionalInstructions: null,
    billingTag: null,
    sandbox: { profileId: null },
  };
  await user.createSession(input);
  etag = false;
  await assert.rejects(user.createSession(input), OutcomeUnknownError);
  const sent = {
    agentTemplateId: "template_1",
    additionalInstructions: null,
    billingTag: null,
    sandbox: { profileId: null },
  };
  assert.deepEqual(bodies, [sent, sent]);
});

test("unusable Template IDs fail before dispatch in creation and filters", async () => {
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    res.end("{}");
  });
  const organization = new OrganizationClient({ baseUrl, apiKey: key });
  const user = organization.user("user_1");
  const range = {
    from: "2030-01-01T00:00:00.000Z",
    to: "2030-01-02T00:00:00.000Z",
  };
  for (const templateId of ["", " t", "t ", "x".repeat(65), 1, null, ["t"]]) {
    await assert.rejects(
      async () => user.createSession({ templateId, idempotencyKey: "ok" }),
      TypeError,
    );
    await assert.rejects(async () => user.listSessions({ templateId }), TypeError);
    await assert.rejects(
      async () => organization.getUserUsage("user_1", { ...range, templateId }),
      TypeError,
    );
    await assert.rejects(
      async () =>
        organization.getUserUsageDetails("user_1", { ...range, templateId }),
      TypeError,
    );
  }
  assert.equal(calls, 0);
});

test("Session options with unsupported types or keys fail before dispatch", async () => {
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    res.end("{}");
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  for (const options of [
    { additionalInstructions: 5 },
    { additionalInstructions: { text: "x" } },
    { sandbox: null },
    { sandbox: "work" },
    { sandbox: { cwd: "work" } },
    { sandbox: { profileId: 1 } },
    { sandbox: { workingDirectory: null } },
  ])
    await assert.rejects(
      user.createSession({
        templateId: "template_1",
        idempotencyKey: "ok",
        ...options,
      }),
      TypeError,
    );
  assert.equal(calls, 0);
});

test("model discovery accepts no options or null options", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ models: [] }));
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  await user.listModels();
  await user.listModels(null);
  assert.deepEqual(urls, [
    "/api/v1/org/users/user_1/agent-models",
    "/api/v1/org/users/user_1/agent-models",
  ]);
});

test("the packaged workflow passes Session options through", async () => {
  const bodies = [];
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify({ templates: [] }));
    bodies.push(JSON.parse(body));
    created(res);
  });
  const { createSessionWorkflow } =
    await import("../examples/create-session.mjs");
  await createSessionWorkflow({
    baseUrl,
    organizationApiKey: key,
    userId: "user_1",
    templateId: "template_1",
    sessionCreationKey: "example-options",
    additionalInstructions: "Use metric units.",
    sandbox: { workingDirectory: "work" },
    acknowledgeSessionRecall: true,
  });
  assert.deepEqual(bodies, [
    {
      agentTemplateId: "template_1",
      additionalInstructions: "Use metric units.",
      sandbox: { workingDirectory: "work" },
      acknowledgeSessionRecall: true,
    },
  ]);
});

test("Sessions can be listed by their current Template", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ sessions: [], hasMore: false, nextCursor: null }));
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  await user.listSessions({ templateId: "template/1", limit: 5 });
  await user.listSessions();
  await assert.rejects(user.listSessions({ agentId: "agent_1" }), TypeError);
  assert.deepEqual(urls, [
    "/api/v1/org/users/user_1/sessions?limit=5&agentTemplateId=template%2F1",
    "/api/v1/org/users/user_1/sessions",
  ]);
});

test("Template discovery preserves empty continuation pages and model discovery accepts dynamic IDs", async () => {
  const urls = [];
  const baseUrl = await serve((req, res) => {
    urls.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify(
        req.url.startsWith("/api/v1/org/users/user_1/agent-models")
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
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  assert.deepEqual(
    await user.listAgentTemplates({ limit: 1, cursor: "opaque+/=" }),
    { templates: [], hasMore: true, nextCursor: "opaque+/=" },
  );
  assert.equal(
    (await user.listModels()).models[0].model,
    "future.model-1",
  );
  // Models no longer depend on an Agent.
  assert.throws(() => user.listModels({ agentId: "agent_1" }), TypeError);
  assert.deepEqual(urls, [
    "/api/v1/org/users/user_1/agent-templates?limit=1&cursor=opaque%2B%2F%3D",
    "/api/v1/org/users/user_1/agent-models",
  ]);
});

test("retired creation selectors, missing identities and unusable owners fail before dispatch without exposing credentials", async () => {
  let calls = 0;
  const baseUrl = await serve((req, res) => {
    calls++;
    res.end("{}");
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  for (const input of [
    { idempotencyKey: "ok" },
    { templateId: " ", idempotencyKey: "ok" },
    { templateId: "t" },
    { templateId: "t", idempotencyKey: "bad key" },
    // Retired selectors: the Agent and its wire name for the Template.
    { agentId: "agent_1", idempotencyKey: "ok" },
    { templateId: "t", agentId: "agent_1", idempotencyKey: "ok" },
    { agentTemplateId: "t", idempotencyKey: "ok" },
    // Native Hardware binding is not part of the SDK.
    { templateId: "t", idempotencyKey: "ok", hardwareIds: ["hw_1"] },
    { templateId: "t", idempotencyKey: "ok", templateVersion: 1 },
  ])
    await assert.rejects(user.createSession(input), TypeError);
  assert.equal("createAgent" in user, false);
  assert.equal("listAgents" in user, false);
  assert.equal("getAgent" in user, false);
  const organization = new OrganizationClient({ baseUrl, apiKey: key });
  for (const userId of [undefined, "", "User 1", "a/b", "x".repeat(65)])
    assert.throws(() => organization.user(userId), TypeError);
  assert.throws(
    () => new OrganizationClient({ baseUrl, apiKey: key, userId: "other" }),
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
    new OrganizationClient({ baseUrl, apiKey: key }).user("user_1").createSession({
      templateId: "template_1",
      idempotencyKey: "abort-recover",
      signal: controller.signal,
    }),
    OutcomeUnknownError,
  );
  assert.equal(calls, 1);
});

test("a truncated retryable response still recovers creation with the original identity", async () => {
  const identities = [];
  const baseUrl = await serve((req, res) => {
    identities.push(req.headers["idempotency-key"]);
    if (identities.length === 1) {
      res.writeHead(503, {
        "content-type": "application/json",
        "content-length": 1000,
      });
      res.write('{"error":');
      setTimeout(() => res.destroy(), 10);
      return;
    }
    created(res);
  });
  const user = new OrganizationClient({ baseUrl, apiKey: key }).user("user_1");
  assert.equal(
    (
      await user.createSession({
        templateId: "template_1",
        idempotencyKey: "recover-truncated",
      })
    ).id,
    "session_1",
  );
  assert.deepEqual(identities, ["recover-truncated", "recover-truncated"]);
});

test("the packaged workflow keeps original creation inputs when catalog defaults change", async () => {
  const bodies = [];
  let catalogReads = 0;
  const baseUrl = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/v1/org/users/user_1/agent-templates")) {
      res.end(
        JSON.stringify({
          templates: [{ agentTemplateId: "changed-template" }],
          hasMore: false,
          nextCursor: null,
        }),
      );
    } else if (req.url.startsWith("/api/v1/org/users/user_1/agent-models")) {
      res.end(
        JSON.stringify({
          effectiveDefaultModel:
            ++catalogReads === 1 ? "first-default" : "new-default",
        }),
      );
    } else {
      bodies.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader("etag", '"model-1"');
      res.writeHead(201).end(
        JSON.stringify({
          session: { sessionId: "session_1", model: "first-default" },
        }),
      );
    }
  });
  const { createSessionWorkflow } =
    await import("../examples/create-session.mjs");
  const input = {
    baseUrl,
    organizationApiKey: key,
    userId: "user_1",
    templateId: "template_1",
    sessionCreationKey: "example-session",
  };
  const first = await createSessionWorkflow(input);
  const second = await createSessionWorkflow(input);
  assert.equal(second.session.id, first.session.id);
  const creation = {
    url: "/api/v1/org/users/user_1/sessions",
    body: { agentTemplateId: "template_1" },
  };
  assert.deepEqual(bodies, [creation, creation]);
});
