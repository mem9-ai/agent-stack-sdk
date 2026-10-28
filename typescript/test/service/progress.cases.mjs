import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  UserClient,
  OrganizationClient,
  TiDBLinkApiError,
  ObservationStoppedError,
  TurnFailedError,
  TurnInterruptedError,
} from "@mem9/tidb-link";
import { observeMessageWorkflow } from "@mem9/tidb-link/examples/observe-message.mjs";
const baseUrl = process.env.SDK_SERVICE_URL;
const user = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const organization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
});
const freshSession = async () =>
  (
    await user.createAgent({
      agentTemplateId: process.env.SDK_TEMPLATE_ID,
      idempotencyKey: randomUUID(),
    })
  ).createSession({ idempotencyKey: randomUUID() });
const wait = { timeoutMs: 15000, pollIntervalMs: 25 };

test("actual SDK progress preserves drafts, resumes from a cursor and confirms the original result", async () => {
  const session = await freshSession();
  const accepted = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE",
  });
  const first = [];
  for await (const event of session.events({
    signal: AbortSignal.timeout(15000),
  })) {
    first.push(event);
    if (event.type === "agent.session.turn.output_text.snapshot") break;
  }
  const cursor = first.at(-1).cursor;
  assert.equal(first.at(-1).data.payload.text, "SDK draft.");
  assert.equal(
    (await session.getInteraction(accepted.inputId)).result.status,
    "running",
  );
  const resumed = [];
  for await (const update of observeMessageWorkflow({
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    sessionId: session.id,
    inputId: accepted.inputId,
    cursor,
    timeoutMs: 15000,
  }))
    resumed.push(update);
  assert(
    resumed.some(
      (update) =>
        update.type === "draft" && update.text === "SDK revised draft.",
    ),
  );
  assert(!resumed.some((update) => update.event?.cursor === cursor));
  assert.equal(resumed.at(-1).result.text, "SDK final answer.");
  assert.equal(resumed.at(-1).result.inputId, accepted.inputId);
  assert.equal((await session.listInteractions()).interactions.length, 1);
  const absent = JSON.parse(Buffer.from(cursor, "base64url").toString());
  absent.sequence += 100000;
  await assert.rejects(
    Array.fromAsync(
      session.events({
        cursor: Buffer.from(JSON.stringify(absent)).toString("base64url"),
        signal: AbortSignal.timeout(5000),
      }),
    ),
    (error) =>
      error instanceof TiDBLinkApiError && error.code === "validation_error",
  );
});

test("actual SDK progress failure keeps drafts provisional", async () => {
  const session = await freshSession();
  const accepted = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PROGRESS SDK_FIXTURE_FAIL",
  });
  const updates = [];
  await assert.rejects(
    async () => {
      for await (const update of session.observe(accepted.inputId, {
        timeoutMs: 15000,
      }))
        updates.push(update);
    },
    (error) =>
      error instanceof TurnFailedError && error.inputId === accepted.inputId,
  );
  assert(updates.some((update) => update.type === "draft"));
  assert(!updates.some((update) => update.type === "result"));
  assert.equal(
    (await session.getInteraction(accepted.inputId)).result.status,
    "failed",
  );
});

test("actual SDK observation timeout retains identity and does not cancel work", async () => {
  const session = await freshSession();
  const accepted = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE",
  });
  await assert.rejects(
    Array.fromAsync(session.observe(accepted.inputId, { timeoutMs: 100 })),
    (error) =>
      error instanceof ObservationStoppedError &&
      error.timedOut &&
      error.inputId === accepted.inputId,
  );
  const result = await session.waitForResult(accepted.inputId, wait);
  assert.equal(result.text, "SDK final answer.");
  assert.equal((await session.listInteractions()).interactions.length, 1);
});

test("live credential revocation stops observation without stopping the original SDK task", async () => {
  const session = await freshSession();
  const issued = await organization.createUserApiKey(session.data.ownerUserId, {
    name: "SDK temporary progress observer",
  });
  const observer = new UserClient({ baseUrl, apiKey: issued.token }).session(
    session.id,
  );
  const accepted = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE SDK_FIXTURE_OBSERVE_LONG",
  });
  let revoked = false;
  await assert.rejects(
    async () => {
      for await (const update of observer.observe(accepted.inputId, {
        timeoutMs: 15000,
      })) {
        if (!revoked && update.type === "draft") {
          await organization.revokeUserApiKey(issued.apiKey.apiKeyId);
          revoked = true;
        }
      }
    },
    (error) =>
      error instanceof ObservationStoppedError &&
      !error.timedOut &&
      error.inputId === accepted.inputId &&
      !!error.cursor,
  );
  assert(revoked);
  assert.equal(
    (await session.getInteraction(accepted.inputId)).result.status,
    "running",
  );
  assert.equal(
    (await session.waitForResult(accepted.inputId, wait)).text,
    "SDK final answer.",
  );
});

test("actual SDK progress distinguishes cancellation from a successful answer", async () => {
  const session = await freshSession();
  const accepted = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PROGRESS SDK_FIXTURE_PAUSE",
  });
  const updates = [];
  let cancelled = false;
  await assert.rejects(
    async () => {
      for await (const update of session.observe(accepted.inputId, {
        timeoutMs: 15000,
      })) {
        updates.push(update);
        if (!cancelled && update.type === "draft") {
          // Arrange remote interruption through the existing public command, not by closing observation.
          const response = await fetch(
            `${baseUrl}/api/v1/user/sessions/${session.id}/events`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${process.env.SDK_USER_KEY}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                type: "agent.session.input.cancel",
                clientEventId: randomUUID(),
                data: { turnId: accepted.turnId },
              }),
            },
          );
          assert.equal(response.status, 202, await response.text());
          cancelled = true;
        }
      }
    },
    (error) =>
      error instanceof TurnInterruptedError &&
      error.inputId === accepted.inputId,
  );
  assert(cancelled);
  assert(updates.some((update) => update.type === "draft"));
  assert(!updates.some((update) => update.type === "result"));
  assert.equal(
    (await session.getInteraction(accepted.inputId)).result.status,
    "interrupted",
  );
});
