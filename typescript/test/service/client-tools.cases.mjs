import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";
const baseUrl = process.env.SDK_SERVICE_URL;
const user = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
}).user(process.env.SDK_USER_ID);
const stranger = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
}).user(process.env.SDK_FOREIGN_USER_ID);
const tool = {
  type: "function",
  name: "lookup_order",
  description: "Look up an application order",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
};
const freshSession = async () =>
  user.createSession({
    templateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
    tools: [tool],
  });

test("the installed SDK declares and replaces complete Client Tool sets under owner authority", async () => {
  const session = await freshSession();
  const original = await session.getClientTools();
  assert.deepEqual(original.tools, [tool]);
  const unchanged = await session.replaceClientTools([tool], {
    ifMatch: original.etag,
  });
  assert.equal(unchanged.etag, original.etag);
  const empty = await session.replaceClientTools([], {
    ifMatch: original.etag,
  });
  assert.deepEqual(empty.tools, []);
  assert.notEqual(empty.etag, original.etag);
  await assert.rejects(
    session.replaceClientTools([tool], { ifMatch: original.etag }),
    (error) => error instanceof TiDBLinkApiError && error.status === 412,
  );
  await assert.rejects(
    stranger.session(session.id).getClientTools(),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});
