import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  UserClient,
  OutcomeUnknownError,
  ConflictError,
} from "../dist/index.js";

const apiKey = "ti_user_scheduler_" + "x".repeat(43);
const servers = [];
after(async () =>
  Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  ),
);
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const body = async (req) =>
  JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || "{}");
const json = (res, value, etag, status = 200) =>
  res
    .writeHead(status, {
      "content-type": "application/json",
      ...(etag ? { etag } : {}),
    })
    .end(JSON.stringify(value));
const scheduler = {
  schedulerId: "sched-1",
  ownerUserId: "u1",
  organizationId: "org1",
  agentId: "a1",
  title: "Report",
  prompt: "Summarize",
  delivery: { target: "new_session", sessionId: null },
  schedule: {
    kind: "once",
    runAt: "2099-01-01T00:00:00.000Z",
    cronExpr: null,
    timezone: "UTC",
  },
  validFrom: null,
  validUntil: null,
  status: "enabled",
  nextFireAt: "2099-01-01T00:00:00.000Z",
  lastFiredAt: null,
  revision: 0,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

test("Scheduler creation preserves stable identity and its original ETag response", async () => {
  const baseUrl = await serve(async (req, res) => {
    assert.equal(req.url, "/api/v1/schedulers");
    assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(req.headers["idempotency-key"], "create-once");
    assert.deepEqual(await body(req), {
      agentId: "a1",
      title: "Report",
      prompt: "Summarize",
      schedule: { kind: "once", after: "1h30m" },
    });
    json(res, { scheduler }, '"scheduler:sched-1:0"', 201);
  });
  const user = new UserClient({ baseUrl, apiKey });
  const result = await user.schedulers.create({
    agentId: "a1",
    title: "Report",
    prompt: "Summarize",
    schedule: { kind: "once", after: "1h30m" },
    idempotencyKey: "create-once",
  });
  assert.deepEqual(result, { scheduler, etag: '"scheduler:sched-1:0"' });
});

test("Scheduler update and deletion use the caller ETag without hiding conflicts or refreshing it", async () => {
  const requests = [];
  const baseUrl = await serve(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.method === "GET") json(res, { scheduler }, '"current"');
    else if (req.headers["if-match"] === '"stale"')
      json(
        res,
        {
          error: { code: "precondition_failed", message: "If-Match is stale" },
        },
        undefined,
        412,
      );
    else if (req.method === "PATCH") {
      assert.equal(req.headers["if-match"], '"current"');
      assert.deepEqual(await body(req), {
        enabled: false,
        validUntil: null,
        delivery: { target: "bound_session", sessionId: "session-1" },
      });
      json(
        res,
        { scheduler: { ...scheduler, status: "disabled", revision: 1 } },
        '"new"',
      );
    } else {
      assert.equal(req.headers["if-match"], '"new"');
      res.writeHead(204).end();
    }
  });
  const user = new UserClient({ baseUrl, apiKey });
  const current = await user.schedulers.get("id/with slash");
  const updated = await user.schedulers.update(
    "id/with slash",
    {
      enabled: false,
      validUntil: null,
      delivery: { target: "bound_session", sessionId: "session-1" },
    },
    { ifMatch: current.etag },
  );
  assert.equal(updated.etag, '"new"');
  await assert.rejects(
    user.schedulers.update(
      "id/with slash",
      { enabled: true },
      { ifMatch: '"stale"' },
    ),
    (error) =>
      error instanceof ConflictError && error.code === "precondition_failed",
  );
  await user.schedulers.delete("id/with slash", { ifMatch: updated.etag });
  assert.deepEqual(
    requests.map((r) => r.method),
    ["GET", "PATCH", "PATCH", "DELETE"],
  );
  assert(
    requests.every((r) => r.path === "/api/v1/schedulers/id%2Fwith%20slash"),
  );
});

test("Scheduler lists and immutable fire history keep their own pagination and nullable outcomes", async () => {
  const fire = {
    fireId: "fire-1",
    schedulerId: "s1",
    scheduledFor: "2026-10-28T00:00:00.000Z",
    executionStatus: "pending",
    execution: {
      agentId: "a1",
      prompt: "Summarize",
      delivery: scheduler.delivery,
    },
    result: {
      sessionId: null,
      turnId: null,
      messageId: null,
      failureCode: null,
    },
    createdAt: "2026-10-28T00:00:00.000Z",
    settledAt: null,
  };
  const baseUrl = await serve((req, res) => {
    const url = new URL(req.url, "http://example");
    assert.equal(url.searchParams.get("cursor"), "scope/+");
    assert.equal(url.searchParams.get("limit"), "1");
    if (url.pathname.endsWith("/fires")) {
      assert.equal(url.searchParams.get("status"), null);
      json(res, { fires: [fire], nextCursor: null });
    } else {
      assert.equal(url.searchParams.get("status"), "enabled");
      json(res, { schedulers: [scheduler], nextCursor: "next" });
    }
  });
  const user = new UserClient({ baseUrl, apiKey });
  assert.deepEqual(
    await user.schedulers.list({
      status: "enabled",
      limit: 1,
      cursor: "scope/+",
    }),
    { schedulers: [scheduler], nextCursor: "next" },
  );
  assert.deepEqual(
    await user.schedulers.fires("s1", { limit: 1, cursor: "scope/+" }),
    { fires: [fire], nextCursor: null },
  );
});

test("unusable mutation receipts and lost responses stay uncertain without repeating a Scheduler command", async () => {
  for (const failure of ["lost", "etag", "identity"]) {
    let attempts = 0;
    const baseUrl = await serve(async (req, res) => {
      attempts++;
      await body(req);
      if (failure === "lost") req.socket.destroy();
      else
        json(
          res,
          { scheduler: failure === "identity" ? {} : scheduler },
          failure === "etag" ? undefined : '"v1"',
          201,
        );
    });
    await assert.rejects(
      new UserClient({ baseUrl, apiKey }).schedulers.create({
        agentId: "a1",
        title: "",
        prompt: "report",
        schedule: { kind: "once", after: "1h" },
        idempotencyKey: "recover-me",
      }),
      (error) => error instanceof OutcomeUnknownError,
    );
    assert.equal(attempts, 1);
  }
});

test("Scheduler commands reject missing concurrency/identity and obsolete selectors before dispatch", async () => {
  let requests = 0;
  const baseUrl = await serve((req, res) => {
    requests++;
    res.end();
  });
  const schedulers = new UserClient({ baseUrl, apiKey }).schedulers;
  await assert.rejects(
    schedulers.update("s", { enabled: false }, {}),
    /ifMatch/,
  );
  await assert.rejects(schedulers.delete("s", { ifMatch: "" }), /ifMatch/);
  await assert.rejects(
    schedulers.create({
      agentId: "a",
      title: "",
      prompt: "x",
      schedule: { kind: "once", after: "1h" },
    }),
    /idempotencyKey/,
  );
  await assert.rejects(
    schedulers.create({
      agentId: "a",
      title: "",
      prompt: "x",
      schedule: { kind: "once", after: "1h" },
      idempotencyKey: "x",
      organizationId: "other",
    }),
    /organizationId/,
  );
  assert.equal(requests, 0);
});

test("an in-progress Scheduler creation exposes its service retry hint without automatically repeating it", async () => {
  let attempts = 0;
  const baseUrl = await serve(async (req, res) => {
    attempts++;
    await body(req);
    res
      .writeHead(409, {
        "content-type": "application/json",
        "retry-after": "1",
        "x-request-id": "scheduler-pending",
      })
      .end(
        JSON.stringify({
          error: {
            code: "idempotency_in_progress",
            message: "Creation still in progress",
          },
        }),
      );
  });
  await assert.rejects(
    new UserClient({ baseUrl, apiKey }).schedulers.create({
      agentId: "a",
      title: "Report",
      prompt: "x",
      schedule: { kind: "once", after: "1h" },
      idempotencyKey: "pending",
    }),
    (error) =>
      error instanceof ConflictError &&
      error.retryAfter === "1" &&
      error.requestId === "scheduler-pending",
  );
  assert.equal(attempts, 1);
});
