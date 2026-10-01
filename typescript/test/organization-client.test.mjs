import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, OrganizationClient, OutcomeUnknownError, TiDBLinkApiError, TiDBLinkError, UserClient } from "../dist/index.js";

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

  await assert.rejects(client.serviceUser("user_1").listApiKeys(), (error) => {
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

test("clients accept only the frozen typed credential grammar before dispatch", async () => {
  const calls = [];
  const baseUrl = await serve((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ apiKeys: [], agents: [] }));
  });
  const secret = "x".repeat(41) + "_A";
  for (const [kind, Client] of [["org", OrganizationClient], ["user", UserClient]]) {
    const invalid = kind === "org" ? [
      `ti_${kind}_key_${"x".repeat(42)}`,
      `ti_${kind}_key_${"x".repeat(44)}`,
      `ti_${kind}__${secret}`,
      `ti_${kind}_${"a".repeat(65)}_${secret}`,
      `ti_${kind}_key_id_${secret}`,
      `ti_${kind}_é_${secret}`,
      `ti_${kind}_key_${"x".repeat(42)}+`,
      `ti_${kind}_key_${secret}\n`,
      `ti_${kind}.key.${secret}`,
      "ag9_oak." + "key." + "x".repeat(32),
      "", null, undefined, 123,
    ] : [`ti_user_key_${"x".repeat(42)}`];
    for (const apiKey of invalid) {
      assert.throws(() => new Client({ baseUrl, apiKey }), (error) => {
        assert(error instanceof TypeError);
        if (typeof apiKey === "string" && apiKey) {
          for (const rendered of [String(error), error.stack, JSON.stringify(error)]) {
            assert(!rendered.includes(apiKey));
          }
        }
        return true;
      });
    }
    assert.equal(calls.length, kind === "org" ? 0 : 2);
    for (const id of ["A", "a".repeat(64)]) {
      const apiKey = `ti_${kind}_${id}_${secret}`;
      const client = new Client({ baseUrl, apiKey });
      assert(!JSON.stringify(client).includes(apiKey));
      if (kind === "org") await client.serviceUser("user_1").listApiKeys();
      else await client.listAgents();
      assert.equal(calls.at(-1).headers.authorization, `Bearer ${apiKey}`);
    }
  }
  assert.equal(calls.length, 4);
});

test("an Organization client manages a Service User's credentials", async () => {
  const calls = [];
  const apiKey = {
    apiKeyId: "uak_1",
    organizationId: "org_1",
    userId: "user_1",
    name: "backend",
    tokenPrefix: "ti_user_1_",
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
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "ti_user_1_" + "a".repeat(43) }));
      return;
    }
    if (request.url === "/api/admin/org/user-api-keys/uak_1/rotate") {
      response.writeHead(201).end(JSON.stringify({ apiKey, token: "ti_user_2_" + "b".repeat(43) }));
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
  assert.equal((await serviceUser.createApiKey({ name: "backend" })).token, "ti_user_1_" + "a".repeat(43));
  assert.equal((await serviceUser.rotateApiKey("uak_1")).token, "ti_user_2_" + "b".repeat(43));
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
  const invalidTokens = [
    "ag9_uak_" + "1_" + "x".repeat(32),
    organizationApiKey,
    "ti_user_1_" + "x".repeat(42),
  ];
  const bodies = [
    "not-json", JSON.stringify({ apiKey: { apiKeyId: "uak_1" } }),
    ...invalidTokens.map((token) => JSON.stringify({ apiKey: { apiKeyId: "uak_1" }, token })),
  ];
  let request = 0;
  const baseUrl = await serve((_request, response) => {
    response.writeHead(201, { "content-type": "application/json" }).end(bodies[request++]);
  });
  const client = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });

  for (let attempt = 0; attempt < bodies.length; attempt += 1) {
    await assert.rejects(
      attempt % 2 === 0
        ? client.serviceUser("user_1").createApiKey({ name: "backend" })
        : client.serviceUser("user_1").rotateApiKey("uak_1"),
      (error) => {
        assert(error instanceof OutcomeUnknownError);
        for (const token of [organizationApiKey, ...invalidTokens]) {
          assert(!String(error).includes(token));
          assert(!JSON.stringify(error).includes(token));
        }
        return true;
      },
    );
    assert.equal(request, attempt + 1);
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
