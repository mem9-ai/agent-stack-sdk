import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { ConflictError, WorkspaceClient } from "../dist/index.js";

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
