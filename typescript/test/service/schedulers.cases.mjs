import { scheduleTaskWorkflow } from "@mem9/tidb-link/examples/schedule-task.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { UserClient, TiDBLinkApiError, ConflictError } from "@mem9/tidb-link";

const baseUrl = process.env.SDK_SERVICE_URL;
const user = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const stranger = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_USER_KEY,
});
const newAgent = () =>
  user.createAgent({
    agentTemplateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });
const later = () => ({ kind: "once", after: "1h" });
const due = () => ({ kind: "once", runAt: new Date().toISOString() });
const waitForFire = async (schedulerId, count = 1) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { fires } = await user.schedulers.fires(schedulerId);
    if (
      fires.length >= count &&
      fires.every((f) => f.executionStatus !== "pending")
    )
      return fires;
    await delay(50);
  }
  assert.fail(
    "Scheduler did not produce a settled fire through its real runner",
  );
};

test("an SDK-created Scheduler fires through the real enabled runner and preserves execution snapshots", async () => {
  const agent = await newAgent();
  const input = {
    agentId: agent.id,
    title: "SDK scheduled work",
    prompt: "SDK_FIXTURE_SCHEDULER first",
    schedule: due(),
    idempotencyKey: randomUUID(),
  };
  const created = await user.schedulers.create(input);
  const id = created.scheduler.schedulerId;
  assert.equal(created.scheduler.delivery.target, "new_session");
  const [first] = await waitForFire(id);
  assert.equal(first.executionStatus, "completed");
  assert.equal(first.result.failureCode, null);
  assert(first.result.sessionId && first.result.turnId);
  const firstTurn = await user
    .session(first.result.sessionId)
    .getTurn(first.result.turnId);
  assert.equal(firstTurn.status, "succeeded");
  assert.equal(firstTurn.assistantMessage.content, "SDK final answer.");
  const firstSession = await user.getSession(first.result.sessionId);
  assert.equal(firstSession.data.createdByType, "scheduler");
  assert.equal(firstSession.data.sourceSchedulerFireId, first.fireId);

  const current = await user.schedulers.get(id);
  await user.schedulers.update(
    id,
    {
      delivery: { target: "bound_session", sessionId: first.result.sessionId },
      prompt: "SDK_FIXTURE_SCHEDULER second",
      schedule: { kind: "once", after: "1s" },
      enabled: true,
    },
    { ifMatch: current.etag },
  );
  const [second, retainedFirst] = await waitForFire(id, 2);
  assert.equal(second.executionStatus, "completed");
  assert.equal(second.result.sessionId, first.result.sessionId);
  assert.notEqual(second.result.turnId, first.result.turnId);
  assert.equal(second.execution.delivery.target, "bound_session");
  assert.equal(retainedFirst.execution.prompt, input.prompt);
  assert.equal(retainedFirst.execution.delivery.target, "new_session");
  const page = await user.schedulers.fires(id, { limit: 1 });
  assert.equal(page.fires[0].fireId, second.fireId);
  assert(page.nextCursor);
  assert.equal(
    (await user.schedulers.fires(id, { limit: 1, cursor: page.nextCursor }))
      .fires[0].fireId,
    first.fireId,
  );
  assert.deepEqual(
    await user.schedulers.create(input),
    created,
    "creation replay is the original response, not current mutable state",
  );
  const refreshed = await user.schedulers.get(id);
  await user.schedulers.delete(id, { ifMatch: refreshed.etag });
});

test("Scheduler CRUD preserves conditional updates, once/cron forms, ownership and paginated filters", async () => {
  const agent = await newAgent();
  const session = await agent.createSession({ idempotencyKey: randomUUID() });
  const input = {
    delivery: { target: "bound_session", sessionId: session.id },
    title: "Bound",
    prompt: "SDK_FIXTURE_SCHEDULER later",
    schedule: later(),
    idempotencyKey: randomUUID(),
  };
  const created = await user.schedulers.create(input);
  const id = created.scheduler.schedulerId;
  assert.equal(created.scheduler.agentId, agent.id);
  assert.equal(created.scheduler.delivery.sessionId, session.id);
  const changed = await user.schedulers.update(
    id,
    { title: "Paused", enabled: false, validFrom: null, validUntil: null },
    { ifMatch: created.etag },
  );
  assert.equal(changed.scheduler.status, "disabled");
  assert.notEqual(changed.etag, created.etag);
  await assert.rejects(
    user.schedulers.update(id, { title: "stale" }, { ifMatch: created.etag }),
    (error) => error instanceof ConflictError && error.status === 412,
  );
  await assert.rejects(
    user.schedulers.delete(id, { ifMatch: created.etag }),
    (error) => error instanceof ConflictError && error.status === 412,
  );
  await assert.rejects(
    user.schedulers.create({ ...input, title: "key reused differently" }),
    (error) =>
      error instanceof ConflictError && error.code === "idempotency_key_reused",
  );
  const second = await user.schedulers.create({
    agentId: agent.id,
    title: "Cron",
    prompt: "SDK_FIXTURE_SCHEDULER cron",
    schedule: {
      kind: "cron",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
    },
    idempotencyKey: randomUUID(),
  });
  const disabled = await user.schedulers.update(
    second.scheduler.schedulerId,
    { enabled: false },
    { ifMatch: second.etag },
  );
  const page = await user.schedulers.list({ status: "disabled", limit: 1 });
  assert.equal(page.schedulers[0].schedulerId, second.scheduler.schedulerId);
  assert(page.nextCursor);
  assert.equal(
    (
      await user.schedulers.list({
        status: "disabled",
        limit: 1,
        cursor: page.nextCursor,
      })
    ).schedulers[0].schedulerId,
    id,
  );
  await assert.rejects(
    stranger.schedulers.get(id),
    (error) =>
      error instanceof TiDBLinkApiError && error.code === "scheduler_not_found",
  );
  await assert.rejects(
    stranger.schedulers.fires(id),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  await assert.rejects(
    stranger.schedulers.create({
      agentId: agent.id,
      title: "Foreign",
      prompt: "foreign",
      schedule: later(),
      idempotencyKey: randomUUID(),
    }),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  await assert.rejects(
    user.schedulers.create({
      delivery: { target: "bound_session", sessionId: "missing-session" },
      title: "Missing",
      prompt: "missing",
      schedule: later(),
      idempotencyKey: randomUUID(),
    }),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  await assert.rejects(
    user.schedulers.update(
      id,
      { schedule: { kind: "cron", cronExpr: "invalid cron", timezone: "UTC" } },
      { ifMatch: changed.etag },
    ),
    (error) => error instanceof TiDBLinkApiError && error.status === 400,
  );
  await user.schedulers.delete(id, { ifMatch: changed.etag });
  await user.schedulers.delete(second.scheduler.schedulerId, {
    ifMatch: disabled.etag,
  });
  await assert.rejects(
    user.schedulers.get(id),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});

test("a scheduled provider failure is readable as failure rather than successful dispatch", async () => {
  const agent = await newAgent();
  const created = await user.schedulers.create({
    agentId: agent.id,
    title: "Expected failure",
    prompt: "SDK_FIXTURE_FAIL scheduled work",
    schedule: due(),
    idempotencyKey: randomUUID(),
  });
  const [fire] = await waitForFire(created.scheduler.schedulerId);
  assert.equal(fire.executionStatus, "failed");
  assert.equal(fire.result.failureCode, "scheduler_execution_failed");
  assert.equal(fire.result.messageId, null);
  assert(fire.result.sessionId && fire.result.turnId);
  assert.equal(
    (await user.session(fire.result.sessionId).getTurn(fire.result.turnId))
      .status,
    "failed",
  );
  const current = await user.schedulers.get(created.scheduler.schedulerId);
  await user.schedulers.delete(created.scheduler.schedulerId, {
    ifMatch: current.etag,
  });
});

test("the installed Scheduler example reads the actual scheduled outcome", async () => {
  const agent = await newAgent();
  const result = await scheduleTaskWorkflow({
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    agentId: agent.id,
    idempotencyKey: randomUUID(),
    runAt: new Date().toISOString(),
    prompt: "SDK_FIXTURE_SCHEDULER example",
    timeoutMs: 15000,
  });
  assert.equal(result.fire.executionStatus, "completed");
  assert.equal(result.turn.assistantMessage.content, "SDK final answer.");
  const current = await user.schedulers.get(result.scheduler.schedulerId);
  await user.schedulers.delete(result.scheduler.schedulerId, {
    ifMatch: current.etag,
  });
});
