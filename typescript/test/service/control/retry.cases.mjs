import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { access } from "node:fs/promises";
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
const wait = { timeoutMs: 15000, pollIntervalMs: 25 };

test("an explicit SDK retry produces its own result without rewriting the stopped input", async () => {
  const agent = await user.getAgent(process.env.SDK_RETRY_AGENT_ID);
  const session = await agent.createSession({ idempotencyKey: randomUUID() });
  const originalInput = {
    clientEventId: randomUUID(),
    text: `SDK_RETRY_${randomUUID()}`,
  };
  const accepted = await session.submitMessage(originalInput);
  let receipt;
  const deadline = Date.now() + 10000;
  do {
    receipt = await session.getInteraction(accepted.inputId);
    if (receipt.appliedAt) break;
    await setTimeout(20);
  } while (Date.now() < deadline);
  assert(
    receipt.appliedAt,
    "Input must be incorporated before it can be retried",
  );
  const supplierDeadline = Date.now() + 15000;
  while (true) {
    try {
      await access(process.env.SDK_RETRY_PAUSED_FILE);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= supplierDeadline)
        throw error;
    }
    await setTimeout(20);
  }
  await session.cancel({
    clientEventId: randomUUID(),
    turnId: accepted.turnId,
  });
  await assert.rejects(
    session.waitForResult(accepted.inputId, wait),
    TurnInterruptedError,
  );
  const original = await session.getInteraction(accepted.inputId);
  const releaseDeadline = Date.now() + 10000;
  while (
    (await session.refresh()).data.activeTurnId !== null &&
    Date.now() < releaseDeadline
  )
    await setTimeout(20);
  assert.equal(
    session.data.activeTurnId,
    null,
    "Cancellation must release active execution before an explicit retry",
  );
  const command = { clientEventId: randomUUID(), turnId: accepted.turnId };
  const retry = await session.retry(command);
  assert.equal(retry.disposition, "retrying");
  assert.equal(retry.turnId, accepted.turnId);
  const observation = await Array.fromAsync(
    session.observe(retry.clientEventId, { timeoutMs: 15000 }),
  );
  assert.equal(observation.at(-1).type, "result");
  const result = observation.at(-1).result;
  const exampleResult = await controlTurnWorkflow({
    baseUrl: process.env.SDK_SERVICE_URL,
    userApiKey: process.env.SDK_USER_KEY,
    sessionId: session.id,
    ...command,
    action: "retry",
  });
  assert.deepEqual(exampleResult, result);
  assert.equal(result.text, "Retried task completed.");
  assert.equal(result.interaction.kind, "retry");
  assert.notEqual(
    result.interaction.result.completedAt,
    original.result.completedAt,
  );
  assert.deepEqual(await session.retry(command), retry);
  assert.deepEqual(
    await session.reconcileInteraction(command.clientEventId),
    result.interaction,
  );
  assert.deepEqual(await session.getInteraction(accepted.inputId), original);
  assert.deepEqual(await session.submitMessage(originalInput), original);
  await assert.rejects(
    session.waitForResult(accepted.inputId, wait),
    TurnInterruptedError,
  );
  await assert.rejects(
    session.retry({ ...command, turnId: "different-turn" }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "interaction_input_conflict",
  );
  const turns = await session.history();
  assert.equal(turns.turns.length, 1);
  assert.equal(turns.turns[0].id, accepted.turnId);
  assert.equal(turns.turns[0].status, "succeeded");
});
