import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, OrganizationClient, OutcomeUnknownError } from "../dist/index.js";

const servers = [];
const organizationApiKey = "ag9_oak." + "key_id." + "x".repeat(32);

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
    response.end(JSON.stringify({ apiKeys: [] }));
  });

  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  assert.deepEqual(await client.serviceUser("user_1").listApiKeys(), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/admin/org/users/user_1/api-keys");
  assert.equal(requests[0].headers.authorization, `Bearer ${organizationApiKey}`);
  assert.equal(requests[0].headers["x-request-id"], requests[1].headers["x-request-id"]);
  assert.equal(requests[0].headers["x-agent9-workspace-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-user-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-organization-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-project-id"], undefined);
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

  await assert.rejects(client.serviceUser("user_1").listApiKeys(), (error) => {
    assert(error instanceof ConflictError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.equal(error.requestId, "request_from_service");
    assert.deepEqual(error.details, { currentRevision: 2 });
    return true;
  });
});

test("an Organization client rejects a User API Key without exposing it", () => {
  const apiKey = "ag9_uak_" + "key_" + "x".repeat(32);

  assert.throws(
    () => new OrganizationClient({ baseUrl: "https://agent.example.com", apiKey }),
    (error) => {
      assert(!String(error).includes(apiKey));
      return true;
    },
  );
});

test("an Organization client manages a Service User's credentials", async () => {
  const calls = [];
  const apiKey = {
    apiKeyId: "uak_1",
    organizationId: "org_1",
    userId: "user_1",
    name: "backend",
    tokenPrefix: "ag9_uak_1_",
    status: "active",
    createdByUserId: null,
    createdByOrganizationApiKeyId: "oak_1",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, body, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/admin/org/users/user_1/api-keys") {
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "one-time-key-1" }));
      return;
    }
    if (request.url === "/api/admin/org/user-api-keys/uak_1/rotate") {
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "one-time-key-2" }));
      return;
    }
    response.writeHead(201).end(
      JSON.stringify({
        apiKey: { ...apiKey, status: "revoked", revokedAt: "2026-08-25T01:00:00.000Z" },
      }),
    );
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  const serviceUser = client.serviceUser("user_1");
  assert.equal(serviceUser.id, "user_1");
  assert.equal((await serviceUser.createApiKey({ name: "backend" })).token, "one-time-key-1");
  assert.equal((await serviceUser.rotateApiKey("uak_1")).token, "one-time-key-2");
  assert.equal((await serviceUser.revokeApiKey("uak_1")).status, "revoked");

  assert.deepEqual(JSON.parse(calls[0].body), { name: "backend" });
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url]),
    [
      ["POST", "/api/admin/org/users/user_1/api-keys"],
      ["POST", "/api/admin/org/user-api-keys/uak_1/rotate"],
      ["POST", "/api/admin/org/user-api-keys/uak_1/revoke"],
    ],
  );
});

test("a lost credential response is outcome unknown and is not retried", async () => {
  let attempts = 0;
  const baseUrl = await serve((request) => {
    attempts += 1;
    request.socket.destroy();
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  await assert.rejects(
    client.serviceUser("user_1").createApiKey({ name: "backend" }),
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.match(error.requestId, /^[0-9a-f-]{36}$/);
      assert(!String(error).includes(organizationApiKey));
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("unusable credential responses are outcome unknown", async () => {
  const bodies = ["not-json", JSON.stringify({ apiKey: { apiKeyId: "uak_1" } })];
  let request = 0;
  const baseUrl = await serve((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" }).end(bodies[request++]);
  });
  const client = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });

  for (let attempt = 0; attempt < bodies.length; attempt += 1) {
    await assert.rejects(
      client.serviceUser("user_1").createApiKey({ name: "backend" }),
      OutcomeUnknownError,
    );
  }
});

test("credential cancellation is outcome unknown only after dispatch", async () => {
  const controller = new AbortController();
  let requests = 0;
  const baseUrl = await serve(() => {
    requests += 1;
    controller.abort(new Error("stop after dispatch"));
  });
  const serviceUser = new OrganizationClient({ baseUrl, apiKey: organizationApiKey }).serviceUser(
    "user_1",
  );

  await assert.rejects(
    serviceUser.createApiKey({ name: "backend", signal: controller.signal }),
    OutcomeUnknownError,
  );

  const beforeDispatch = new AbortController();
  beforeDispatch.abort(new Error("stop before dispatch"));
  await assert.rejects(
    serviceUser.createApiKey({ name: "backend", signal: beforeDispatch.signal }),
    /stop before dispatch/,
  );
  assert.equal(requests, 1);
});

test("offboarding revokes every active key and leaves revoked keys alone", async () => {
  const revoked = [];
  const baseUrl = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(
        JSON.stringify({
          apiKeys: [
            { apiKeyId: "uak_active", status: "active" },
            { apiKeyId: "uak_revoked", status: "revoked" },
          ],
        }),
      );
      return;
    }
    revoked.push(request.url);
    response.writeHead(201).end(
      JSON.stringify({ apiKey: { apiKeyId: "uak_active", status: "revoked" } }),
    );
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  const result = await client.serviceUser("user_1").revokeAllApiKeys();

  assert.deepEqual(result, [{ apiKeyId: "uak_active", status: "revoked" }]);
  assert.deepEqual(revoked, ["/api/admin/org/user-api-keys/uak_active/revoke"]);
});
