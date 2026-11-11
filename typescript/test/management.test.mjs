import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConflictError,
  OrganizationClient,
  OutcomeUnknownError,
  TiDBLinkError,
} from "../dist/index.js";

const apiKey = "ti_org_manage_" + "x".repeat(43);
const baseUrl = "https://tidb-link.test";
const json = (value, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A client whose transport answers from `handler` and records each request. */
const client = (handler) => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      method: init.method ?? "GET",
      path: url.pathname.replace("/api/v1/org", "") + url.search,
      headers: new Headers(init.headers),
      body:
        init.body === undefined
          ? undefined
          : new Uint8Array(await new Response(init.body).arrayBuffer()),
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { organization: new OrganizationClient({ baseUrl, apiKey, fetch }), calls };
};

const summary = {
  id: "tmpl_1",
  organizationId: "org_1",
  name: "assistant",
  displayName: "Assistant",
  sandboxProfile: "default",
  lifecycleStatus: "active",
  etag: '"cvc1.' + "a".repeat(43) + '"',
  contentDigest: "b".repeat(64),
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};
const content = {
  identity: { agentName: "Assistant" },
  instructions: "Be brief.",
  sandbox: { profileId: "default" },
  realtime: { language: "en-US" },
};
const template = { template: summary, content };

test("Templates are created, read, listed, replaced and archived with their concurrency headers", async () => {
  const { organization, calls } = client((call) => {
    if (call.method === "GET" && call.path.startsWith("/agent-templates?"))
      return json({ data: [summary], hasMore: false, nextCursor: null, readAt: summary.createdAt });
    if (call.path === "/agent-template-reference-catalog")
      return json({ models: [], sandboxes: [{ id: "default", label: "Default", capabilities: [] }], skills: [] });
    return json(template, call.method === "POST" && call.path === "/agent-templates" ? 201 : 200);
  });
  const { templates } = organization;

  assert.deepEqual(
    await templates.create({ displayName: "Assistant", content, idempotencyKey: "create-1" }),
    template,
  );
  assert.deepEqual(await templates.get("tmpl_1"), template);
  assert.equal(
    (await templates.list({ lifecycleStatus: "active", q: "assist", limit: 10 })).data[0].id,
    "tmpl_1",
  );
  assert.equal((await templates.catalog()).sandboxes[0].id, "default");
  await templates.replace(
    "tmpl_1",
    { displayName: "Assistant", content: { ...content, instructions: "Be kind." } },
    { ifMatch: summary.etag, idempotencyKey: "replace-1" },
  );
  await templates.archive("tmpl_1", { ifMatch: summary.etag, idempotencyKey: "archive-1" });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /agent-templates",
      "GET /agent-templates/tmpl_1",
      "GET /agent-templates?lifecycleStatus=active&q=assist&limit=10",
      "GET /agent-template-reference-catalog",
      "PUT /agent-templates/tmpl_1",
      "POST /agent-templates/tmpl_1/archive",
    ],
  );
  assert.equal(calls[0].headers.get("idempotency-key"), "create-1");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].body)), {
    displayName: "Assistant",
    content,
  });
  for (const [index, key] of [[4, "replace-1"], [5, "archive-1"]]) {
    assert.equal(calls[index].headers.get("if-match"), summary.etag);
    assert.equal(calls[index].headers.get("idempotency-key"), key);
  }
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[5].body)), {});
});

test("Template creation is retried with its key, and a stale ETag is a ConflictError", async () => {
  const { organization, calls } = client((call, count) => {
    if (count === 1) throw new TypeError("socket closed");
    if (call.method === "PUT")
      return json({ error: { code: "resource_conflict", message: "Stale" } }, 409);
    return json(template, 201);
  });
  await organization.templates.create({
    displayName: "Assistant",
    content,
    idempotencyKey: "create-1",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get("idempotency-key"), "create-1");
  assert.equal(calls[0].headers.get("x-request-id"), calls[1].headers.get("x-request-id"));
  await assert.rejects(
    organization.templates.replace(
      "tmpl_1",
      { displayName: "Assistant", content },
      { ifMatch: '"old"', idempotencyKey: "replace-1" },
    ),
    ConflictError,
  );
});

test("Template inputs are checked before any request", async () => {
  const { organization, calls } = client(() => json(template));
  const { templates } = organization;
  await assert.rejects(templates.create({ displayName: "A", content }), TypeError);
  await assert.rejects(
    templates.create({ displayName: "", content, idempotencyKey: "k" }),
    TypeError,
  );
  await assert.rejects(
    templates.replace("tmpl_1", { displayName: "A", content }, { idempotencyKey: "k" }),
    TypeError,
  );
  await assert.rejects(
    templates.archive("tmpl_1", { ifMatch: '"e"', idempotencyKey: "k", force: true }),
    TypeError,
  );
  await assert.rejects(templates.list({ status: "active" }), TypeError);
  assert.equal(calls.length, 0);
});

test("an unusable Template receipt is an uncertain outcome", async () => {
  const { organization } = client(() => json({ template: null }, 201));
  await assert.rejects(
    organization.templates.create({ displayName: "A", content, idempotencyKey: "k" }),
    OutcomeUnknownError,
  );
});

const upload = (state, extra = {}) => ({
  upload: {
    uploadId: "upl_1",
    skillId: "skill_1",
    state,
    byteSize: 3,
    sha256: "c".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    validation: {
      entriesTotal: 1,
      fileCount: 1,
      entriesDone: 1,
      declaredBytes: 3,
      bytesDone: 3,
      diagnostics: [],
      failureCode: null,
      failurePath: null,
    },
    version: null,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...extra,
  },
});

test("a Skill ZIP is uploaded as bytes, validated, published and read", async () => {
  const states = ["pending", "validating", "awaiting_confirmation", "finalizing", "done"];
  const { organization, calls } = client((call) => {
    if (call.method === "POST" && call.path === "/skills/uploads")
      return json(upload("pending"), 202);
    if (call.method === "GET" && call.path === "/skills/uploads/upl_1") {
      const state = states.shift();
      return json(upload(state, state === "done" ? { version: 1 } : {}));
    }
    if (call.path === "/skills/uploads/upl_1/publish")
      return json(upload("finalizing"), 202);
    if (call.path.startsWith("/skills?"))
      return json({ skills: [], nextCursor: null });
    if (call.path === "/skills/skill_1")
      return json({ skill: { skillId: "skill_1" }, versions: [], nextCursor: null });
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const { skills } = organization;
  const bytes = new Uint8Array([0x50, 0x4b, 0x05]);
  const created = await skills.upload({ bytes, idempotencyKey: "zip-1" });
  assert.equal(created.state, "pending");
  assert.equal(
    (await skills.waitForUpload("upl_1", { intervalMs: 0 })).state,
    "awaiting_confirmation",
  );
  await skills.publish("upl_1", { idempotencyKey: "publish-1" });
  const done = await skills.waitForUpload("upl_1", { until: ["done", "failed"], intervalMs: 0 });
  assert.equal(done.version, 1);
  await skills.list({ limit: 5 });
  await skills.get("skill_1");

  assert.equal(calls[0].headers.get("content-type"), "application/octet-stream");
  assert.equal(calls[0].headers.get("idempotency-key"), "zip-1");
  assert.deepEqual(calls[0].body, bytes);
  const publish = calls.find((call) => call.path.endsWith("/publish"));
  assert.equal(publish.method, "POST");
  assert.equal(publish.headers.get("idempotency-key"), "publish-1");
  assert.equal(publish.body, undefined);
});

test("waiting for a Skill upload stops at its local limit, and cancellation sends DELETE", async () => {
  const { organization, calls } = client((call) =>
    call.method === "DELETE" ? json(undefined, 204) : json(upload("validating")),
  );
  await assert.rejects(
    organization.skills.waitForUpload("upl_1", { timeoutMs: 0, intervalMs: 1 }),
    (error) => error instanceof TiDBLinkError && /still validating/.test(error.message),
  );
  await organization.skills.cancelUpload("upl_1");
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).path, "/skills/uploads/upl_1");
  await assert.rejects(
    organization.skills.upload({ bytes: new Uint8Array(), idempotencyKey: "k" }),
    TypeError,
  );
});
