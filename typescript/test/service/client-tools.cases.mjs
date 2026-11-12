import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";
import { answerClientToolWorkflow } from "@tidblink/server/examples/answer-client-tool.mjs";
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
async function pending(session) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const calls = await session.listPendingClientToolCalls();
    if (calls.length) return calls;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "The actual Runtime did not publish the requested Client Tool call",
  );
}

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
  await assert.rejects(
    stranger.session(session.id).listPendingClientToolCalls(),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  assert.deepEqual(await session.listPendingClientToolCalls(), []);
});

for (const outcome of ["success", "failure"])
  test(`real SDK Client Tool ${outcome} is explicitly supplied by the application and reaches the final answer`, async () => {
    const session = await freshSession();
    const message = await session.submitMessage({
      clientEventId: randomUUID(),
      text: "SDK_FIXTURE_CLIENT_TOOL",
    });
    const calls = await pending(session);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.turnId, message.turnId);
    assert.equal(call.name, "lookup_order");
    assert.deepEqual(call.arguments, { orderId: "order_1" });
    assert.equal(
      Date.parse(call.deadlineAt) - Date.parse(call.publishedAt),
      60000,
    );
    // A reconnected client reads the same pending identity without an event subscription.
    assert.equal(
      (await user.session(session.id).listPendingClientToolCalls())[0].callId,
      call.callId,
    );
    const tools = await session.getClientTools();
    await session.replaceClientTools([], { ifMatch: tools.etag });
    await assert.rejects(
      stranger
        .session(session.id)
        .submitClientToolOutput({
          clientEventId: randomUUID(),
          turnId: call.turnId,
          callId: call.callId,
          output: "forged",
        }),
      (error) => error instanceof TiDBLinkApiError && error.status === 404,
    );
    const literal =
      outcome === "success"
        ? "SDK_APPLICATION_ORDER_SHIPPED"
        : "SDK_APPLICATION_ORDER_UNAVAILABLE";
    const command = {
      clientEventId: randomUUID(),
      turnId: call.turnId,
      callId: call.callId,
      ...(outcome === "success"
        ? { output: literal }
        : { error: { message: literal } }),
    };
    const accepted =
      outcome === "success"
        ? await answerClientToolWorkflow({
            baseUrl,
            organizationApiKey: process.env.SDK_ORGANIZATION_KEY,
    userId: process.env.SDK_USER_ID,
            sessionId: session.id,
            ...command,
          })
        : await session.submitClientToolOutput(command);
    assert.equal(accepted.kind, "client_tool_output");
    assert.equal(accepted.mode, "accepted");
    const answer = await session.waitForResult(message.inputId, {
      timeoutMs: 15000,
      pollIntervalMs: 25,
    });
    assert(answer.text.includes(literal));
    assert.equal(
      (await session.getInteraction(accepted.inputId)).kind,
      "client_tool_output",
    );
    assert.deepEqual(await session.listPendingClientToolCalls(), []);
    assert.equal(
      (await session.submitClientToolOutput(command)).inputId,
      accepted.inputId,
    );
    await assert.rejects(
      session.submitClientToolOutput({
        ...command,
        clientEventId: randomUUID(),
      }),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.code === "client_tool_call_settled",
    );
    await assert.rejects(
      session.submitClientToolOutput({
        ...command,
        clientEventId: randomUUID(),
        callId: "missing-call",
      }),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.code === "client_tool_call_unavailable",
    );
  });
