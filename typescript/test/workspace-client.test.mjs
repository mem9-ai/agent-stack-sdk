import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, OutcomeUnknownError, WorkspaceClient } from "../dist/index.js";

const servers = [];

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

test("a Workspace client retries a safe read with one request identity", async () => {
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

  const client = new WorkspaceClient({
    baseUrl,
    apiKey: "ag9_wak.key_id.secret_value_that_is_long_enough",
  });

  assert.deepEqual(await client.serviceUser("user_1").listApiKeys(), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/admin/users/user_1/api-keys");
  assert.equal(requests[0].headers.authorization, "Bearer ag9_wak.key_id.secret_value_that_is_long_enough");
  assert.equal(requests[0].headers["x-request-id"], requests[1].headers["x-request-id"]);
  assert.equal(requests[0].headers["x-agent9-workspace-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-user-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-organization-id"], undefined);
  assert.equal(requests[0].headers["x-agent9-project-id"], undefined);
});

test("a service conflict preserves safe error details", async () => {
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
  const client = new WorkspaceClient({
    baseUrl,
    apiKey: "ag9_wak.key_id.secret_value_that_is_long_enough",
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

test("a Workspace client rejects a User API Key without exposing it", () => {
  const apiKey = "ag9_uak_key_secret_value_that_must_not_leak";

  assert.throws(
    () => new WorkspaceClient({ baseUrl: "https://agent.example.com", apiKey }),
    (error) => {
      assert(!String(error).includes(apiKey));
      return true;
    },
  );
});

test("a Workspace client provisions a Service User and manages its credentials", async () => {
  const calls = [];
  const apiKey = {
    apiKeyId: "uak_1",
    organizationId: "org_1",
    workspaceId: "workspace_1",
    userId: "user_1",
    name: "backend",
    tokenPrefix: "ag9_uak_1_",
    status: "active",
    createdByUserId: null,
    createdByWorkspaceApiKeyId: "wak_1",
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
    if (request.url === "/api/admin/users") {
      response.writeHead(201).end(
        JSON.stringify({
          user: {
            userId: "user_1",
            organizationId: "org_1",
            kind: "service",
            orgRole: "member",
            serviceTier: "v0",
            serviceTierUpdatedAt: "2026-08-25T00:00:00.000Z",
            email: null,
            displayName: "Customer One",
            createdAt: "2026-08-25T00:00:00.000Z",
          },
          membership: {
            userId: "user_1",
            workspaceId: "workspace_1",
            role: "member",
            status: "active",
          },
        }),
      );
      return;
    }
    if (request.url === "/api/admin/users/user_1/api-keys") {
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "ag9_uak_1_first_secret" }));
      return;
    }
    if (request.url === "/api/admin/user-api-keys/uak_1/rotate") {
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "ag9_uak_1_second_secret" }));
      return;
    }
    response.writeHead(201).end(
      JSON.stringify({
        apiKey: { ...apiKey, status: "revoked", revokedAt: "2026-08-25T01:00:00.000Z" },
      }),
    );
  });
  const client = new WorkspaceClient({
    baseUrl,
    apiKey: "ag9_wak.key_id.secret_value_that_is_long_enough",
  });

  const serviceUser = await client.createServiceUser({
    displayName: "Customer One",
    requestId: "provision_customer_1",
  });
  assert.equal(serviceUser.id, "user_1");
  assert.equal(serviceUser.user?.displayName, "Customer One");
  assert.equal(serviceUser.membership?.status, "active");
  assert.equal((await serviceUser.createApiKey({ name: "backend" })).token, "ag9_uak_1_first_secret");
  assert.equal((await serviceUser.rotateApiKey("uak_1")).token, "ag9_uak_1_second_secret");
  assert.equal((await serviceUser.revokeApiKey("uak_1")).status, "revoked");

  assert.deepEqual(JSON.parse(calls[0].body), { displayName: "Customer One" });
  assert.equal(calls[0].headers["x-request-id"], "provision_customer_1");
  assert.deepEqual(JSON.parse(calls[1].body), { name: "backend" });
  assert.deepEqual(
    calls.map(({ method, url }) => [method, url]),
    [
      ["POST", "/api/admin/users"],
      ["POST", "/api/admin/users/user_1/api-keys"],
      ["POST", "/api/admin/user-api-keys/uak_1/rotate"],
      ["POST", "/api/admin/user-api-keys/uak_1/revoke"],
    ],
  );
});

test("a lost credential response is outcome unknown and is not retried", async () => {
  let attempts = 0;
  const baseUrl = await serve((request) => {
    attempts += 1;
    request.socket.destroy();
  });
  const client = new WorkspaceClient({
    baseUrl,
    apiKey: "ag9_wak.key_id.secret_value_that_is_long_enough",
  });

  await assert.rejects(
    client.serviceUser("user_1").createApiKey({ name: "backend" }),
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.match(error.requestId, /^[0-9a-f-]{36}$/);
      assert(!String(error).includes("ag9_wak.key_id.secret_value_that_is_long_enough"));
      return true;
    },
  );
  assert.equal(attempts, 1);
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
  const client = new WorkspaceClient({
    baseUrl,
    apiKey: "ag9_wak.key_id.secret_value_that_is_long_enough",
  });

  const result = await client.serviceUser("user_1").revokeAllApiKeys();

  assert.deepEqual(result, [{ apiKeyId: "uak_active", status: "revoked" }]);
  assert.deepEqual(revoked, ["/api/admin/user-api-keys/uak_active/revoke"]);
});
