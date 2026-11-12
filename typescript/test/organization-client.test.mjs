import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, ConnectionError, OrganizationClient, OutcomeUnknownError, TiDBLinkApiError, TiDBLinkError } from "../dist/index.js";

const servers = [];
const organizationApiKey = "ti_org_" + "keyId_" + "x".repeat(43);

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

test("an Organization client retries a safe read with one request identity", async () => {
  const requests = [];
  const baseUrl = await serve((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (requests.length === 1) {
      response.writeHead(503).end(
        JSON.stringify({ error: { code: "service_unavailable", message: "Try later" } }),
      );
      return;
    }
    response.end(JSON.stringify({ users: [] }));
  });

  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  assert.deepEqual(await client.listEndUsers(), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/v1/org/users");
  assert.equal(requests[0].headers.authorization, `Bearer ${organizationApiKey}`);
  assert.equal(requests[0].headers["x-request-id"], requests[1].headers["x-request-id"]);
  assert.equal(requests[0].headers["x-agent9-workspace-id"], undefined);
  assert.equal(requests[0].headers["x-ti-workspace-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-user-id"], undefined);
  assert.equal(requests[0].headers["x-ti-user-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-organization-id"], undefined);
  assert.equal(requests[0].headers["x-ti-organization-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-project-id"], undefined);
  assert.equal(requests[0].headers["x-ti-project-id"], undefined);
});

test("an Organization service conflict preserves safe error details", async () => {
  const baseUrl = await serve((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("x-request-id", "request_from_service");
    response.writeHead(409).end(
      JSON.stringify({
        error: {
          code: "revision_conflict",
          message: "The resource changed",
          details: { currentRevision: 2 },
        },
      }),
    );
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  await assert.rejects(client.listEndUsers(), (error) => {
    assert(error instanceof ConflictError);
    assert(error instanceof TiDBLinkApiError);
    assert(error instanceof TiDBLinkError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.equal(error.requestId, "request_from_service");
    assert.deepEqual(error.details, { currentRevision: 2 });
    return true;
  });
});

test("an Organization client rejects a User API Key without exposing it", () => {
  const apiKey = "ti_user_" + "key_" + "x".repeat(43);

  assert.throws(
    () => new OrganizationClient({ baseUrl: "https://agent.example.com", apiKey }),
    (error) => {
      assert(!String(error).includes(apiKey));
      return true;
    },
  );
});

test("the client accepts only the frozen Organization credential grammar before dispatch", async () => {
  const calls = [];
  const baseUrl = await serve((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ users: [] }));
  });
  const secret = "x".repeat(40) + "-_A";
  for (const apiKey of [
    `ti_org_key_${"x".repeat(42)}`,
    `ti_org_key_${"x".repeat(44)}`,
    `ti_org__${secret}`,
    `ti_org_${"a".repeat(65)}_${secret}`,
    `ti_org_key_id_${secret}`,
    `ti_org_é_${secret}`,
    `ti_org_key_${"x".repeat(42)}+`,
    `ti_org_key_${secret}\n`,
    `ti_org_key_\n${secret}`,
    `ti_org.key.${secret}`,
    `ti_user_key_${secret}`,
    "ag9_oak." + "key." + "x".repeat(32),
    "", null, undefined, 123,
  ]) {
    assert.throws(() => new OrganizationClient({ baseUrl, apiKey }), (error) => {
      assert(error instanceof TypeError);
      if (typeof apiKey === "string" && apiKey) {
        for (const rendered of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
          assert(!rendered.includes(apiKey));
        }
      }
      return true;
    });
  }
  assert.equal(calls.length, 0);
  for (const id of ["A", "a".repeat(64)]) {
    const apiKey = `ti_org_${id}_${secret}`;
    const client = new OrganizationClient({ baseUrl, apiKey });
    assert(!JSON.stringify(client).includes(apiKey));
    await client.listEndUsers();
    assert.equal(calls.at(-1).headers.authorization, `Bearer ${apiKey}`);
  }
  assert.equal(calls.length, 2);
});

test("an Organization client confirms its Organization without identity selectors", async () => {
  const organization = {
    organizationId: "org_1",
    slug: "customer",
    name: null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
  const baseUrl = await serve((request, response) => {
    assert.equal(request.url, "/api/v1/org");
    assert.equal(request.headers.authorization, `Bearer ${organizationApiKey}`);
    assert.equal(request.headers["x-agent9-project-id"], undefined);
    assert.equal(request.headers["x-ti-organization-id"], undefined);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ organization }));
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  assert.deepEqual(await client.getOrganization(), organization);
});

test("native End Users can be created, listed and retrieved with their external mapping", async () => {
  const user = {
    userId: "user/1",
    organizationId: "org_1",
    displayName: "Customer",
    externalId: "customer-1",
    status: "active",
    createdAt: "now",
    updatedAt: "now",
  };
  const baseUrl = await serve(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(request.url, "/api/v1/org/users");
      assert.deepEqual(JSON.parse(body), {
        displayName: "Customer",
        externalId: "customer-1",
      });
      assert.equal(request.headers["x-request-id"], "create_customer_1");
      response.writeHead(201).end(JSON.stringify({ user }));
    } else if (request.url === "/api/v1/org/users") {
      response.end(JSON.stringify({ users: [user] }));
    } else {
      assert.equal(request.url, "/api/v1/org/users/user%2F1");
      response.end(JSON.stringify({ user }));
    }
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const created = await client.createEndUser(
    { displayName: "Customer", externalId: "customer-1" },
    { requestId: "create_customer_1" },
  );
  assert.deepEqual(created, user);
  assert.deepEqual(await client.listEndUsers(), [user]);
  assert.deepEqual(await client.getEndUser(created.userId), user);
});

test("End User creation with an externalId is retried with the same request identity", async () => {
  const requests = [];
  const user = {
    userId: "user_1",
    organizationId: "org_1",
    displayName: null,
    externalId: "customer-1",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const baseUrl = await serve((request, response) => {
    requests.push(request.headers["x-request-id"]);
    if (requests.length === 1) return request.socket.destroy();
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ user }));
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  assert.deepEqual(
    await client.createEndUser({ externalId: "customer-1" }, { requestId: "create_1" }),
    user,
  );
  assert.deepEqual(requests, ["create_1", "create_1"]);
});

test("a lost End User creation response without an externalId is not replayed", async () => {
  let requests = 0;
  const baseUrl = await serve((request) => {
    requests++;
    request.socket.destroy();
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  await assert.rejects(
    client.createEndUser({ displayName: "Customer" }, { requestId: "create_1" }),
    OutcomeUnknownError,
  );
  assert.equal(requests, 1);
  await assert.rejects(
    client.createEndUser({ displayName: "Customer", unexpected: true }),
    TypeError,
  );
  assert.equal(requests, 1);
  await assert.rejects(client.listEndUsers(), (error) => {
    assert(error instanceof ConnectionError);
    assert(!(error instanceof OutcomeUnknownError));
    return true;
  });
});

test("unusable creation receipts retain the request identity for reconciliation", async () => {
  const baseUrl = await serve((_request, response) => {
    response
      .writeHead(201, { "x-request-id": "create_receipt" })
      .end(JSON.stringify({ user: null }));
  });
  await assert.rejects(
    new OrganizationClient({
      baseUrl,
      apiKey: organizationApiKey,
    }).createEndUser(),
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.equal(error.requestId, "create_receipt");
      return true;
    },
  );
});

test("service errors retain body request identity, and uncertain server failures retain their error", async () => {
  const baseUrl = await serve((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: {
          code: "service_unavailable",
          message: "Service unavailable",
          requestId: "body_request",
          details: { reason: "commit_unknown" },
        },
      }),
    );
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  await assert.rejects(
    client.createEndUser({ externalId: "customer-1" }),
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.equal(error.requestId, "body_request");
      assert(error.cause instanceof TiDBLinkApiError);
      assert.equal(error.cause.status, 503);
      assert.equal(error.cause.code, "service_unavailable");
      assert.deepEqual(error.cause.details, { reason: "commit_unknown" });
      return true;
    },
  );
});

test("redirects never send an API Key to another recipient", async () => {
  let received = 0;
  const recipient = await serve((_request, response) => {
    received++;
    response.end("{}");
  });
  const baseUrl = await serve((_request, response) => {
    response.writeHead(307, { location: recipient }).end();
  });
  await assert.rejects(
    new OrganizationClient({
      baseUrl,
      apiKey: organizationApiKey,
    }).createEndUser(),
    OutcomeUnknownError,
  );
  assert.equal(received, 0);
});

test("public request options cannot change operations or enable unsafe replay", async () => {
  const requests = [];
  let inFlightOptions;
  const baseUrl = await serve((request, response) => {
    requests.push(request.method);
    if (inFlightOptions) {
      if (request.method === "GET") inFlightOptions.retry = "safe";
      else
        return response
          .writeHead(503, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              error: {
                code: "service_unavailable",
                message: "Outcome uncertain",
              },
            }),
          );
    }
    response
      .writeHead(200, { "content-type": "application/json", etag: "model-v1" })
      .end(JSON.stringify({ session: { sessionId: "session_1" } }));
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const session = client.user("user_1").session("session_1");
  for (const operation of [
    () => client.createEndUser({}, { idempotent: true }),
    () => session.refresh({ method: "DELETE", body: { unexpected: true } }),
    () => session.getRealtimeConnection({ method: "DELETE" }),
    () => session.suggestName({ userText: "Name this" }, { idempotent: true }),
    () => session.rename("Name", { retry: "safe" }),
  ])
    await assert.rejects(operation(), TypeError);
  assert.deepEqual(requests, []);
  inFlightOptions = {};
  await assert.rejects(
    session.setModel("next-model", inFlightOptions),
    OutcomeUnknownError,
  );
  assert.deepEqual(requests, ["GET", "PATCH"]);
});

test("Organization authority selects an explicit owner across existing resource handles", async () => {
  const calls = [];
  const baseUrl = await serve((request, response) => {
    calls.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", '"revision-1"');
    response.end(JSON.stringify({
      sessions: [], templates: [], models: [], files: [],
      session: { sessionId: "session_1" },
      capabilities: {}, hasMore: false, nextCursor: null,
    }));
  });
  const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
  for (const owner of ["", "../user", "user/other", undefined, null])
    assert.throws(() => organization.user(owner), TypeError);
  assert.equal(calls.length, 0);
  const owner = organization.user("user_1");
  await owner.createSession({ templateId: "template_1", idempotencyKey: "s-1" });
  await owner.listSessions({ limit: 2 });
  await owner.session("session_1").refresh();
  await owner.listAgentTemplates();
  await owner.listModels();
  await owner.listRealtimeModels();
  await owner.files.list();
  await owner.files.capabilities();
  assert.deepEqual(calls.map(({ url }) => url), [
    "/api/v1/org/users/user_1/sessions",
    "/api/v1/org/users/user_1/sessions?limit=2",
    "/api/v1/org/users/user_1/sessions/session_1",
    "/api/v1/org/users/user_1/agent-templates",
    "/api/v1/org/users/user_1/agent-models",
    "/api/v1/org/users/user_1/realtime-models",
    "/api/v1/org/users/user_1/files",
    "/api/v1/org/users/user_1/drive/upload-capabilities",
  ]);
  assert(calls.every(({ authorization }) => authorization === `Bearer ${organizationApiKey}`));
  assert(!inspect(owner).includes(organizationApiKey));
});
