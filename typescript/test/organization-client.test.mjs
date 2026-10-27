import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  AgentStackApiError,
  ConflictError,
  ConnectionError,
  OutcomeUnknownError,
  OrganizationClient,
} from "../dist/index.js";

const servers = [];
const organizationApiKey = "ti_org_key1_" + "x".repeat(43);
after(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
});
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

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

test("an Organization client retries a safe read with one request identity", async () => {
  const requests = [];
  const baseUrl = await serve((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (requests.length === 1) {
      response
        .writeHead(503)
        .end(
          JSON.stringify({
            error: { code: "service_unavailable", message: "Try later" },
          }),
        );
      return;
    }
    response.end(JSON.stringify({ apiKeys: [] }));
  });

  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  assert.deepEqual(await client.listUserApiKeys("user_1"), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/api/v1/org/users/user_1/api-keys");
  assert.equal(
    requests[0].headers.authorization,
    `Bearer ${organizationApiKey}`,
  );
  assert.equal(
    requests[0].headers["x-request-id"],
    requests[1].headers["x-request-id"],
  );
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
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  await assert.rejects(client.listUserApiKeys("user_1"), (error) => {
    assert(error instanceof ConflictError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.equal(error.requestId, "request_from_service");
    assert.deepEqual(error.details, { currentRevision: 2 });
    return true;
  });
});

test("an Organization client rejects a User API Key without exposing it", () => {
  const apiKey = "ti_user_" + "key1_" + "x".repeat(43);

  assert.throws(
    () =>
      new OrganizationClient({ baseUrl: "https://agent.example.com", apiKey }),
    (error) => {
      assert(!String(error).includes(apiKey));
      return true;
    },
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
    client.createUserApiKey("user_1", { name: "backend" }),
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
  const bodies = [
    "not-json",
    JSON.stringify({ apiKey: { apiKeyId: "uak_1" } }),
  ];
  let request = 0;
  const baseUrl = await serve((_request, response) => {
    response
      .writeHead(201, { "content-type": "application/json" })
      .end(bodies[request++]);
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  for (let attempt = 0; attempt < bodies.length; attempt += 1) {
    await assert.rejects(
      client.createUserApiKey("user_1", { name: "backend" }),
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
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });

  await assert.rejects(
    client.createUserApiKey(
      "user_1",
      { name: "backend" },
      { signal: controller.signal },
    ),
    OutcomeUnknownError,
  );

  const beforeDispatch = new AbortController();
  beforeDispatch.abort(new Error("stop before dispatch"));
  await assert.rejects(
    client.createUserApiKey(
      "user_1",
      { name: "backend" },
      { signal: beforeDispatch.signal },
    ),
    /stop before dispatch/,
  );
  assert.equal(requests, 1);
});

test("a lost rotation or User creation response is not replayed", async () => {
  let requests = 0;
  const baseUrl = await serve((request) => {
    requests++;
    request.socket.destroy();
  });
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  for (const operation of [
    () => client.rotateUserApiKey("key_1", { requestId: "rotate_1" }),
    () =>
      client.createEndUser(
        { externalId: "customer-1" },
        { requestId: "create_1" },
      ),
  ])
    await assert.rejects(operation(), OutcomeUnknownError);
  assert.equal(requests, 2);
  await assert.rejects(client.listUserApiKeys("user_1"), (error) => {
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
    client.createUserApiKey("user_1", { name: "backend" }),
    (error) => {
      assert(error instanceof OutcomeUnknownError);
      assert.equal(error.requestId, "body_request");
      assert(error.cause instanceof AgentStackApiError);
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

for (const failure of ["disconnect", "conflict"]) {
  test(`the provisioning example reconciles ${failure} without issuing twice`, async () => {
    const { provisionUser } = await import("../examples/provision-user.mjs");
    let user;
    let creations = 0;
    let issuances = 0;
    const baseUrl = await serve((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/org") {
        response.end(
          JSON.stringify({ organization: { organizationId: "org_1" } }),
        );
      } else if (
        request.url === "/api/v1/org/users" &&
        request.method === "GET"
      ) {
        response.end(JSON.stringify({ users: user ? [user] : [] }));
      } else if (
        request.url === "/api/v1/org/users" &&
        request.method === "POST"
      ) {
        creations++;
        user = { userId: "user_1", externalId: "customer-1" };
        if (failure === "disconnect") request.socket.destroy();
        else
          response
            .writeHead(409)
            .end(
              JSON.stringify({
                error: { code: "resource_conflict", message: "Already exists" },
              }),
            );
      } else {
        assert.equal(request.url, "/api/v1/org/users/user_1/api-keys");
        issuances++;
        if (issuances > 1) request.socket.destroy();
        else
          response
            .writeHead(201)
            .end(
              JSON.stringify({
                apiKey: { apiKeyId: "key_1" },
                token: "one-time",
              }),
            );
      }
    });
    const input = { baseUrl, organizationApiKey, externalId: " customer-1 " };
    assert.equal((await provisionUser(input)).user.userId, "user_1");
    await assert.rejects(provisionUser(input), OutcomeUnknownError);
    assert.equal(creations, 1);
    assert.equal(issuances, 2);
  });
}
