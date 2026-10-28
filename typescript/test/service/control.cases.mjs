import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import {
  UserClient,
  TiDBLinkApiError,
  TurnInterruptedError,
} from "@mem9/tidb-link";

import { controlTurnWorkflow } from "@mem9/tidb-link/examples/control-turn.mjs";

const user = new UserClient({
  baseUrl: process.env.SDK_SERVICE_URL,
  apiKey: process.env.SDK_USER_KEY,
});
const freshSession = async () => {
  const agent = await user.createAgent({
    agentTemplateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });
  return agent.createSession({ idempotencyKey: randomUUID() });
};
async function incorporated(session, inputId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const receipt = await session.getInteraction(inputId);
    if (receipt.appliedAt) return receipt;
    await setTimeout(20);
  }
  throw new Error("Original input was not incorporated");
}

test("SDK messages steer the active Turn and preserve their own incorporation and result", async () => {
  const session = await freshSession();
  const initial = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_PAUSE",
  });
  await incorporated(session, initial.inputId);
  const steering = await session.submitMessage({
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_ADDITIONAL_REQUIREMENT",
  });
  assert.equal(steering.mode, "steered");
  assert.equal(steering.turnId, initial.turnId);
  const result = await session.waitForResult(steering.inputId, {
    timeoutMs: 15000,
    pollIntervalMs: 25,
  });
  assert.equal(result.interaction.result.status, "succeeded");
  assert(result.interaction.appliedAt);
  const original = await session.getInteraction(initial.inputId);
  assert.equal(
    original.result.completedAt,
    result.interaction.result.completedAt,
  );
  const turn = await session.getTurn(initial.turnId);
  assert(
    turn.userMessages.some(
      (message) => message.content === "SDK_FIXTURE_ADDITIONAL_REQUIREMENT",
    ),
  );
});

test("SDK cancellation settles the original Turn and disabled retry remains a refusal", async () => {
  const session = await freshSession();
  const input = { clientEventId: randomUUID(), text: "SDK_FIXTURE_PAUSE" };
  const started = await session.submitMessage(input);
  await incorporated(session, started.inputId);
  const command = { clientEventId: randomUUID(), turnId: started.turnId };
  const accepted = await controlTurnWorkflow({
    baseUrl: process.env.SDK_SERVICE_URL,
    userApiKey: process.env.SDK_USER_KEY,
    sessionId: session.id,
    ...command,
    action: "cancel",
  });
  assert.equal(accepted.kind, "cancel");
  assert.equal(accepted.turnId, started.turnId);
  await assert.rejects(
    session.waitForResult(started.inputId, {
      timeoutMs: 15000,
      pollIntervalMs: 25,
    }),
    TurnInterruptedError,
  );
  const original = await session.getInteraction(started.inputId);
  const cancellation = await session.getInteraction(command.clientEventId);
  assert.equal(cancellation.result.status, "interrupted");
  assert.equal(cancellation.result.completedAt, original.result.completedAt);
  assert.deepEqual(await session.cancel(command), cancellation);
  await assert.rejects(
    session.cancel({ clientEventId: randomUUID(), turnId: started.turnId }),
    (error) => error instanceof TiDBLinkApiError && error.status === 409,
  );
  await assert.rejects(
    session.retry({ clientEventId: randomUUID(), turnId: started.turnId }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "checkpoint_runtime_unavailable",
  );
  assert.deepEqual(await session.submitMessage(input), original);
  const stranger = new UserClient({
    baseUrl: process.env.SDK_SERVICE_URL,
    apiKey: process.env.SDK_FOREIGN_USER_KEY,
  });
  await assert.rejects(
    stranger
      .session(session.id)
      .cancel({ clientEventId: randomUUID(), turnId: started.turnId }),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});
