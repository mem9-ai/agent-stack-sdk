import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  UserClient,
  OutcomeUnknownError,
  TurnWaitTimeoutError,
  TurnFailedError,
  TurnInterruptedError,
  TiDBLinkApiError,
} from "@mem9/tidb-link";
import { sendMessageWorkflow } from "@mem9/tidb-link/examples/send-message.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const apiKey = process.env.SDK_USER_KEY;
assert(
  baseUrl && apiKey && process.env.SDK_TEXT_SESSION_ID,
  "Run through npm run test:service",
);
const user = new UserClient({ baseUrl, apiKey });
const freshSession = async () => {
  const agent = await user.createAgent({
    agentTemplateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });
  return agent.createSession({ idempotencyKey: randomUUID() });
};
const waitOptions = { timeoutMs: 15000, pollIntervalMs: 25 };

async function allPages(read, key) {
  const items = [];
  let cursor;
  do {
    const page = await read({ limit: 1, ...(cursor ? { cursor } : {}) });
    items.push(...page[key]);
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      return items;
    }
    assert(page.nextCursor);
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error("Pagination did not terminate");
}

test("actual SDK text acceptance, final results and paged Full Agent/Realtime history", async () => {
  const session = user.session(process.env.SDK_TEXT_SESSION_ID);
  const input = { clientEventId: randomUUID(), text: "SDK_FIXTURE_SUCCESS" };
  const accepted = await session.submitMessage(input);
  assert.equal(accepted.inputId, input.clientEventId);
  assert.equal(accepted.kind, "message");
  assert.equal(accepted.mode, "started");
  const result = await session.waitForResult(input.clientEventId, waitOptions);
  assert.equal(result.type, "answer");
  assert.equal(result.inputId, input.clientEventId);
  assert.equal(result.sessionId, session.id);
  assert.equal(result.text, "SDK final answer.");
  assert.equal(result.interaction.appliedAt !== null, true);
  assert.equal(result.interaction.result.status, "succeeded");
  const replay = await session.submitMessage(input);
  assert.equal(replay.turnId, result.turnId);
  assert.equal(
    (await session.reconcileInteraction(input.clientEventId)).turnId,
    result.turnId,
  );
  assert.equal(await session.reconcileInteraction(randomUUID()), null);
  await assert.rejects(
    session.submitMessage({ ...input, text: "Different content" }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "interaction_input_conflict",
  );
  await session.turn(
    { clientEventId: randomUUID(), text: "SDK_FIXTURE_SECOND_MESSAGE" },
    waitOptions,
  );
  const interactions = await allPages(
    (options) => session.listInteractions(options),
    "interactions",
  );
  assert.equal(interactions.length, 2);
  assert.equal(interactions[0].inputId, input.clientEventId);
  const turns = await allPages((options) => session.history(options), "turns");
  const full = turns.find((turn) => turn.id === result.turnId);
  assert(full);
  assert.equal(full.assistantMessage.content, result.text);
  assert.equal(full.userMessage.content, input.text);
  const realtime = turns.find((turn) => turn.executor === "realtime_model");
  assert(realtime, "Saved Realtime facts must remain conversation Turns");
  assert.equal(realtime.userMessage.content, "Saved spoken question");
  assert.equal(realtime.assistantMessage.content, "Saved spoken answer");
  assert.equal(realtime.assistantMessage.realtime.interrupted, true);
  assert.equal(
    (await session.getTurn(result.turnId)).assistantMessage.id,
    result.messageId,
  );
  assert.equal((await session.getTurn(realtime.id)).executor, "realtime_model");
  const timeline = await allPages(
    (options) => session.timeline(options),
    "entries",
  );
  assert(
    timeline.some(
      (entry) => entry.type === "turn" && entry.turn.id === result.turnId,
    ),
  );
  assert(
    timeline.some(
      (entry) =>
        entry.type === "realtime" &&
        entry.realtime.type === "input_transcript" &&
        entry.realtime.text === "Saved spoken question",
    ),
  );
  assert(
    timeline.some(
      (entry) =>
        entry.type === "realtime" &&
        entry.realtime.type === "response" &&
        entry.realtime.interrupted === true,
    ),
  );
  const stranger = new UserClient({
    baseUrl,
    apiKey: process.env.SDK_FOREIGN_USER_KEY,
  }).session(session.id);
  for (const read of [
    () => stranger.getInteraction(input.clientEventId),
    () => stranger.listInteractions(),
    () => stranger.history(),
    () => stranger.getTurn(result.turnId),
    () => stranger.timeline(),
  ]) {
    await assert.rejects(
      read(),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.status === 404 &&
        error.code === "session_not_found",
    );
  }
});

test("actual failed and interrupted executions preserve original message outcomes", async () => {
  const failed = await freshSession();
  const failedId = randomUUID();
  await assert.rejects(
    failed.turn(
      { clientEventId: failedId, text: "SDK_FIXTURE_FAIL" },
      waitOptions,
    ),
    (error) =>
      error instanceof TurnFailedError &&
      error.inputId === failedId &&
      error.sessionId === failed.id,
  );
  const failure = await failed.getInteraction(failedId);
  assert.equal(failure.result.status, "failed");
  assert.equal((await failed.getTurn(failure.turnId)).status, "failed");

  const interrupted = await freshSession();
  const interruptedId = randomUUID();
  const admitted = await interrupted.submitMessage({
    clientEventId: interruptedId,
    text: "SDK_FIXTURE_PAUSE interruption",
  });
  // Explicit cancellation is test arrangement for the message's interrupted outcome.
  const cancelled = await fetch(
    `${baseUrl}/api/v1/user/sessions/${interrupted.id}/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "agent.session.input.cancel",
        clientEventId: randomUUID(),
        data: { turnId: admitted.turnId },
      }),
    },
  );
  assert.equal(cancelled.status, 202, await cancelled.text());
  await assert.rejects(
    interrupted.waitForResult(interruptedId, waitOptions),
    (error) =>
      error instanceof TurnInterruptedError &&
      error.inputId === interruptedId &&
      error.sessionId === interrupted.id &&
      error.turnId === admitted.turnId,
  );
  assert.equal(
    (await interrupted.getInteraction(interruptedId)).result.status,
    "interrupted",
  );
});

test("local timeout and abandoned waiting leave actual execution recoverable", async () => {
  const session = await freshSession();
  const inputId = randomUUID();
  const admitted = await session.submitMessage({
    clientEventId: inputId,
    text: "SDK_FIXTURE_PAUSE local waiting",
  });
  await assert.rejects(
    session.waitForResult(inputId, { timeoutMs: 30, pollIntervalMs: 5 }),
    (error) =>
      error instanceof TurnWaitTimeoutError &&
      error.inputId === inputId &&
      error.sessionId === session.id,
  );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30);
  try {
    await assert.rejects(
      session.waitForResult(inputId, { ...waitOptions, signal: abort.signal }),
      (error) =>
        error instanceof OutcomeUnknownError &&
        error.inputId === inputId &&
        error.sessionId === session.id,
    );
  } finally {
    clearTimeout(timer);
  }
  const stillRunning = await session.getInteraction(inputId);
  assert.equal(stillRunning.result.status, "running");
  const recovered = await session.waitForResult(inputId, waitOptions);
  assert.equal(recovered.turnId, admitted.turnId);
  assert.equal(recovered.text, "SDK final answer.");
  const interactions = await session.listInteractions();
  assert.equal(interactions.interactions.length, 1);
});

test("a lost actual service response recovers the original submission without a second POST", async () => {
  const session = await freshSession();
  const clientEventId = randomUUID();
  const requestId = `diagnostic_${randomUUID()}`;
  let posts = 0;
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${baseUrl}${request.url}`, {
        method: request.method,
        headers: {
          authorization: request.headers.authorization,
          "content-type": "application/json",
          "x-request-id": request.headers["x-request-id"],
        },
        ...(request.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.method === "POST") {
        posts += 1;
        assert([200, 202].includes(upstream.status));
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(bytes);
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const proxied = new UserClient({
      baseUrl: `http://127.0.0.1:${proxy.address().port}`,
      apiKey,
    }).session(session.id);
    await assert.rejects(
      proxied.submitMessage({
        clientEventId,
        text: "SDK_FIXTURE_LOST_RESPONSE",
        requestId,
      }),
      (error) =>
        error instanceof OutcomeUnknownError &&
        error.inputId === clientEventId &&
        error.sessionId === session.id &&
        error.requestId === requestId,
    );
    assert.equal(posts, 1);
    const receipt = await session.reconcileInteraction(clientEventId);
    assert(receipt);
    const result = await session.waitForResult(clientEventId, waitOptions);
    assert.equal(result.turnId, receipt.turnId);
    assert.equal(result.text, "SDK final answer.");
    assert.equal((await session.listInteractions()).interactions.length, 1);
    assert.equal(posts, 1);
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("the installed message example waits for a real final result and recovers its stable identity", async () => {
  const session = await freshSession();
  const input = {
    baseUrl,
    userApiKey: apiKey,
    sessionId: session.id,
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_EXAMPLE",
    timeoutMs: 15000,
  };
  const result = await sendMessageWorkflow(input);
  assert.equal(result.text, "SDK final answer.");
  const replay = await sendMessageWorkflow(input);
  assert.equal(replay.turnId, result.turnId);
  const executable = fileURLToPath(
    import.meta.resolve("@mem9/tidb-link/examples/send-message.mjs"),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [executable],
    {
      env: {
        ...process.env,
        AGENT_SERVICE_URL: baseUrl,
        USER_API_KEY: apiKey,
        SESSION_ID: session.id,
        CLIENT_EVENT_ID: input.clientEventId,
        MESSAGE_TEXT: input.text,
      },
    },
  );
  assert.equal(stdout.trim(), "SDK final answer.");
  assert(!(stdout + stderr).includes(apiKey));
  assert.equal((await session.listInteractions()).interactions.length, 1);
});
