import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  ConflictError,
  OutcomeUnknownError,
  OrganizationClient,
  TiDBLinkApiError,
} from "../dist/index.js";

const servers = [];
const organizationApiKey = "ti_org_" + "key_" + "x".repeat(43);

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
  new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  }).user("user_1");

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
  billingTag: { key: "customer", value: "acme" },
  model: "gpt-5.6-terra",
  modelRevision: 1,
  realtimeModel: null,
  realtimeModelRevision: 1,
  realtimeModelEtag: '"session-realtime-model:session_1:1"',
  realtimeVoice: null,
  template: { templateId: "template_1", contentDigest: "a".repeat(64) },
  realtime: null,
  configurationEpoch: 1,
  switching: false,
  modelPolicyStatus: "allowed",
  status: "active",
  activeTurnId: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

test("an explicit Template creates a persistent Session and retains its model ETag", async () => {
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
    response.setHeader("etag", '"session-v1"');
    response.writeHead(201).end(JSON.stringify({ session: sessionRecord() }));
  });
  const user = clientFor(baseUrl);

  await assert.rejects(user.createSession({}), TypeError);
  await assert.rejects(
    user.createSession({ idempotencyKey: "session-1" }),
    TypeError,
  );
  assert.equal(calls.length, 0);
  const session = await user.createSession({
    templateId: "template_1",
    billingTag: { key: "customer", value: "acme" },
    model: "deployment.model",
    idempotencyKey: "session-1",
  });

  assert.equal(session.id, "session_1");
  assert.equal(session.model, "gpt-5.6-terra");
  assert.equal(session.data.template.templateId, "template_1");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "/api/v1/org/users/user_1/sessions");
  assert.deepEqual(JSON.parse(calls[0].body), {
    agentTemplateId: "template_1",
    model: "deployment.model",
    billingTag: { key: "customer", value: "acme" },
  });
  assert.equal(calls[0].headers["idempotency-key"], "session-1");
  assert.equal(calls[0].headers["x-agent9-project-id"], undefined);
  assert.equal(calls[0].headers["x-ti-project-id"], undefined);
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
      ["GET", "/api/v1/org/users/user_1/sessions/session_1"],
      ["PATCH", "/api/v1/org/users/user_1/sessions/session_1/model"],
      ["PATCH", "/api/v1/org/users/user_1/sessions/session_1/model"],
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
      ["POST", "/api/v1/org/users/user_1/sessions/session_1/name"],
      ["PATCH", "/api/v1/org/users/user_1/sessions/session_1/billing-tag"],
      ["PATCH", "/api/v1/org/users/user_1/sessions/session_1/model"],
      ["POST", "/api/v1/org/users/user_1/sessions/session_1/name"],
    ],
  );
});

test("Session creation with exhausted retries preserves the caller key for explicit recovery", async () => {
  let fail = true;
  const identities = [];
  const baseUrl = await serve((req, res) => {
    identities.push(req.headers["idempotency-key"]);
    if (fail) {
      res.destroy();
      return;
    }
    res
      .writeHead(201, { "content-type": "application/json", etag: '"model-1"' })
      .end(JSON.stringify({ session: sessionRecord() }));
  });
  const user = clientFor(baseUrl);
  const options = { templateId: "template_1", idempotencyKey: "session-recover" };
  await assert.rejects(user.createSession(options), OutcomeUnknownError);
  fail = false;
  assert.equal((await user.createSession(options)).id, "session_1");
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

const switchPath = "/api/v1/org/users/user_1/sessions/session_1/template-switches";
const switchReceipt = (overrides = {}) => ({
  commandId: "stsw_1",
  sessionId: "session_1",
  agentTemplateId: "template_2",
  status: "pending",
  configurationEpoch: 1,
  handoffTurnId: "turn_handoff",
  createdAt: "2026-11-12T00:00:00.000Z",
  ...overrides,
});
const sameKeyHint = (error) =>
  error instanceof OutcomeUnknownError &&
  error.sessionId === "session_1" &&
  /same idempotencyKey/.test(error.message);
const reply = (response, status, body) =>
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
const switchContract = JSON.parse(
  await readFile(new URL("../service-contract/openapi.json", import.meta.url)),
);

test("a Template switch validates locally and sends the body and key the frozen contract accepts", async () => {
  const calls = [];
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, headers: request.headers, body });
    reply(response, 202, { receipt: switchReceipt() });
  });
  const session = clientFor(baseUrl).session("session_1");

  for (const input of [
    {},
    { templateId: "template_2" },
    { idempotencyKey: "switch-1" },
    { templateId: " template_2", idempotencyKey: "switch-1" },
    { templateId: "t".repeat(65), idempotencyKey: "switch-1" },
    { templateId: "template_2", idempotencyKey: "switch 1" },
    { templateId: "template_2", idempotencyKey: "_switch" },
    { templateId: "template_2", idempotencyKey: "k".repeat(129) },
    { templateId: "template_2", idempotencyKey: "switch-1", acknowledgeSessionRecall: "yes" },
    { agentTemplateId: "template_2", idempotencyKey: "switch-1" },
  ])
    await assert.rejects(session.switchTemplate(input), TypeError);
  await assert.rejects(
    session.switchTemplate({ templateId: "template_2", idempotencyKey: "_x" }),
    /^TypeError: Template switch requires a stable idempotencyKey/,
  );
  assert.equal(calls.length, 0);

  const longest = "k".repeat(128);
  const receipt = await session.switchTemplate({
    templateId: "template_2",
    idempotencyKey: longest,
    acknowledgeSessionRecall: true,
    requestId: "request-1",
  });
  assert.deepEqual(receipt, switchReceipt());
  await session.switchTemplate({ templateId: "template_2", idempotencyKey: "switch-2" });

  assert.deepEqual(calls.map((call) => call.url), [switchPath, switchPath]);
  assert.deepEqual(JSON.parse(calls[0].body), {
    agentTemplateId: "template_2",
    acknowledgeSessionRecall: true,
  });
  assert.equal(calls[0].headers["idempotency-key"], longest);
  assert.equal(calls[0].headers["x-request-id"], "request-1");
  assert.deepEqual(JSON.parse(calls[1].body), { agentTemplateId: "template_2" });

  // Every body the SDK sent fits the frozen request schema and key grammar.
  const operation =
    switchContract.paths["/api/v1/org/users/{userId}/sessions/{id}/template-switches"]
      .post;
  const schema = switchContract.components.schemas.SwitchSessionTemplateOpenApiDto;
  const keyPattern = new RegExp(
    operation.parameters.find((p) => p.name === "Idempotency-Key").schema.pattern,
  );
  for (const call of calls) {
    const body = JSON.parse(call.body);
    for (const field of schema.required) assert(field in body, field);
    for (const [field, value] of Object.entries(body)) {
      const declared = schema.properties[field];
      assert(declared, `undeclared field ${field}`);
      assert.equal(typeof value, declared.type);
    }
    assert.match(call.headers["idempotency-key"], keyPattern);
  }
});

test("a Template switch replays its command: latest receipt by key, reuse refused, replay before the busy check", async () => {
  // Modelled on the service's switch command store: keyed by Idempotency-Key and
  // request hash, the replay answered before the in-progress and busy checks.
  const commands = new Map();
  const bodies = new Map();
  let fence = null;
  let epoch = 1;
  const baseUrl = await serve(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const key = request.headers["idempotency-key"];
    bodies.set(key, [...(bodies.get(key) ?? []), raw]);
    const body = JSON.parse(raw);
    const hash = JSON.stringify([
      "session_1",
      body.agentTemplateId,
      body.acknowledgeSessionRecall === true,
    ]);
    const prior = commands.get(key);
    if (prior) {
      if (prior.hash !== hash)
        return reply(response, 409, {
          error: { code: "idempotency_key_reused", message: "Reused" },
        });
      return reply(response, 202, { receipt: prior.receipt });
    }
    if (fence)
      return reply(response, 409, {
        error: { code: "session_switch_in_progress", message: "Switching" },
      });
    const receipt = switchReceipt({
      commandId: `stsw_${commands.size + 1}`,
      agentTemplateId: body.agentTemplateId,
      configurationEpoch: epoch,
      handoffTurnId: `turn_handoff_${commands.size + 1}`,
    });
    commands.set(key, { hash, receipt });
    fence = key;
    reply(response, 202, { receipt });
  });
  const settle = () => {
    const command = commands.get(fence);
    epoch += 1;
    command.receipt = {
      ...command.receipt,
      status: "succeeded",
      configurationEpoch: epoch,
      completedAt: "2026-11-12T00:00:05.000Z",
    };
    fence = null;
  };
  const session = clientFor(baseUrl).session("session_1");
  const input = { templateId: "template_2", idempotencyKey: "switch-1" };

  const pending = await session.switchTemplate(input);
  assert.equal(pending.status, "pending");
  assert.equal(pending.handoffTurnId, "turn_handoff_1");
  assert.deepEqual(await session.switchTemplate(input), pending);
  await assert.rejects(
    session.switchTemplate({ templateId: "template_3", idempotencyKey: "switch-2" }),
    (error) =>
      error instanceof ConflictError && error.code === "session_switch_in_progress",
  );
  settle();
  const settled = await session.switchTemplate(input);
  assert.deepEqual(settled, {
    ...pending,
    status: "succeeded",
    configurationEpoch: 2,
    completedAt: "2026-11-12T00:00:05.000Z",
  });
  await assert.rejects(
    session.switchTemplate({ ...input, templateId: "template_3" }),
    (error) =>
      error instanceof ConflictError &&
      error.status === 409 &&
      error.code === "idempotency_key_reused",
  );
  const replays = bodies.get("switch-1");
  assert.equal(replays.length, 4);
  assert.equal(new Set(replays.slice(0, 3)).size, 1);
});

test("an uncertain Template switch names its Session, keeps its key and is recovered by repeating the input", async () => {
  let drops = 4;
  let hold = false;
  const keys = [];
  const baseUrl = await serve((request, response) => {
    keys.push(request.headers["idempotency-key"]);
    if (hold) return;
    if (drops-- > 0) return response.destroy();
    reply(response, 202, {
      receipt: switchReceipt({
        status: "succeeded",
        configurationEpoch: 2,
        completedAt: "2026-11-12T00:00:01.000Z",
      }),
    });
  });
  const session = clientFor(baseUrl).session("session_1");
  const input = { templateId: "template_2", idempotencyKey: "switch-recover" };

  await assert.rejects(session.switchTemplate(input), sameKeyHint);
  assert.equal(keys.length, 3);
  // One more dropped response is retried automatically with the same key.
  const receipt = await session.switchTemplate(input);
  assert.equal(receipt.status, "succeeded");
  assert.equal(keys.length, 5);
  assert(keys.every((key) => key === input.idempotencyKey));

  hold = true;
  const controller = new AbortController();
  const sent = session.switchTemplate({ ...input, signal: controller.signal });
  while (keys.length < 6) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(sent, sameKeyHint);
});

test("pre-recording 503 refusals are definite; other server failures stay uncertain", async () => {
  const codes = [];
  const baseUrl = await serve((request, response) => {
    reply(response, 503, { error: { code: codes[0], message: "Unavailable" } });
  });
  const session = clientFor(baseUrl).session("session_1");
  const input = { templateId: "template_2", idempotencyKey: "switch-1" };
  for (const code of ["turn_admission_closed", "skill_package_store_unavailable"]) {
    codes[0] = code;
    await assert.rejects(
      session.switchTemplate(input),
      (error) =>
        error instanceof TiDBLinkApiError &&
        !(error instanceof OutcomeUnknownError) &&
        error.status === 503 &&
        error.code === code,
    );
  }
  codes[0] = "service_unavailable";
  await assert.rejects(session.switchTemplate(input), sameKeyHint);
});

test("Template switch receipts are returned as-is per status and unusable ones are uncertain", async () => {
  const replies = [];
  const baseUrl = await serve((request, response) => {
    const [status, body] = replies.shift();
    reply(response, status, body);
  });
  const session = clientFor(baseUrl).session("session_1");
  const input = { templateId: "template_2", idempotencyKey: "switch-1" };

  replies.push([409, { error: { code: "session_switch_busy", message: "Busy" } }]);
  await assert.rejects(
    session.switchTemplate(input),
    (error) =>
      error instanceof ConflictError &&
      error.status === 409 &&
      error.code === "session_switch_busy",
  );
  replies.push([404, { error: { code: "agent_template_unavailable", message: "Gone" } }]);
  await assert.rejects(
    session.switchTemplate(input),
    (error) =>
      error instanceof TiDBLinkApiError &&
      !(error instanceof ConflictError) &&
      error.status === 404 &&
      error.code === "agent_template_unavailable",
  );

  const { handoffTurnId: _, ...withoutHandoff } = switchReceipt();
  for (const receipt of [
    switchReceipt(),
    { ...withoutHandoff, status: "unchanged" },
    {
      ...switchReceipt(),
      status: "failed",
      completedAt: "2026-11-12T00:00:05.000Z",
      error: { code: "session_switch_conflict" },
    },
    {
      ...withoutHandoff,
      status: "succeeded",
      configurationEpoch: 2,
      completedAt: "2026-11-12T00:00:05.000Z",
    },
  ]) {
    replies.push([202, { receipt }]);
    assert.deepEqual(await session.switchTemplate(input), receipt);
  }

  for (const body of [
    {},
    { receipt: switchReceipt({ sessionId: "session_2" }) },
    { receipt: switchReceipt({ agentTemplateId: "template_3" }) },
    { receipt: switchReceipt({ commandId: "" }) },
    { receipt: switchReceipt({ status: "running" }) },
    { receipt: switchReceipt({ createdAt: undefined }) },
    { receipt: switchReceipt({ configurationEpoch: 0 }) },
    { receipt: switchReceipt({ configurationEpoch: 1.5 }) },
    { receipt: withoutHandoff },
    { receipt: switchReceipt({ status: "failed" }) },
    { receipt: switchReceipt({ status: "failed", error: {} }) },
    { receipt: switchReceipt({ status: "unchanged" }) },
  ]) {
    replies.push([202, body]);
    await assert.rejects(session.switchTemplate(input), sameKeyHint);
  }
  assert.equal(replies.length, 0);
});
