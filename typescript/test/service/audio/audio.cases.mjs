import { submitAudioWorkflow } from "@mem9/tidb-link/examples/submit-audio.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { UserClient, TiDBLinkApiError, TurnFailedError } from "@mem9/tidb-link";
const baseUrl = process.env.SDK_SERVICE_URL;
const user = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const stranger = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_USER_KEY,
});
const budget = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_AUDIO_BUDGET_USER_KEY,
});
const wav = () => {
  const bytes = Buffer.alloc(364);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(320, 40);
  return bytes;
};
const newSession = async (client = user) =>
  (
    await client.createAgent({
      agentTemplateId: process.env.SDK_TEMPLATE_ID,
      idempotencyKey: randomUUID(),
    })
  ).createSession({
    idempotencyKey: randomUUID(),
    billingTag: { key: "audio", value: "default" },
  });
const recording = (filename = "voice.wav") => ({
  filename,
  contentType: "audio/wav",
  bytes: wav(),
});

test("actual audio bytes become transcribed input and a successful saved Turn with correct Billing Tag semantics", async () => {
  const session = await newSession();
  const result = await session.audio({ ...recording(), billingTag: null });
  assert.equal(result.type, "answer");
  assert.equal(result.text, "Audio final answer.");
  const turn = await session.getTurn(result.turnId);
  assert.equal(
    turn.userMessage.content,
    "SDK_FIXTURE_AUDIO transcribed speech",
  );
  assert.equal(turn.userMessage.inputContext.channel, "audio");
  assert.equal(turn.billingTag, null);
  assert.equal(turn.assistantMessage.id, result.messageId);
  const inherited = await session.audio(recording());
  assert.deepEqual((await session.getTurn(inherited.turnId)).billingTag, {
    key: "audio",
    value: "default",
  });
  const overridden = await session.audio({
    ...recording(),
    billingTag: { key: "audio", value: "override" },
  });
  assert.deepEqual((await session.getTurn(overridden.turnId)).billingTag, {
    key: "audio",
    value: "override",
  });
  assert.deepEqual(
    (await session.listInteractions()).interactions,
    [],
    "audio has no ordinary text-input receipt",
  );
});

test("actual audio preserves unsupported/malformed/provider and budget refusals before a Turn starts", async () => {
  const session = await newSession();
  await assert.rejects(
    session.audio({
      filename: "not-audio.bin",
      contentType: "application/octet-stream",
      bytes: wav(),
    }),
    (error) => error instanceof TiDBLinkApiError && error.status === 400,
  );
  await assert.rejects(
    session.audio({
      ...recording("malformed.wav"),
      bytes: Buffer.from("not a recording"),
    }),
    (error) => error instanceof TiDBLinkApiError && error.code === "asr_failed",
  );
  await assert.rejects(
    session.audio(recording("provider-refused.wav")),
    (error) => error instanceof TiDBLinkApiError && error.code === "asr_failed",
  );
  assert.deepEqual((await session.history()).turns, []);
  const limited = await newSession(budget);
  await assert.rejects(
    limited.audio(recording("budget.wav")),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.status === 429 &&
      error.code === "llm_spend_limit_exhausted",
  );
  await assert.rejects(
    stranger.session(session.id).audio(recording()),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});

test("audio model failure is terminal failure and closing its active response requests interruption", async () => {
  const failed = await newSession();
  let failedId;
  await assert.rejects(failed.audio(recording("model-fail.wav")), (error) => {
    assert(error instanceof TurnFailedError);
    failedId = error.turnId;
    return true;
  });
  assert.equal((await failed.getTurn(failedId)).status, "failed");
  const session = await newSession();
  let turnId;
  for await (const event of session.streamAudio(recording("paused.wav"))) {
    if (event.event === "turn_started") {
      turnId = event.turnId;
      break;
    }
  }
  assert(turnId);
  const deadline = Date.now() + 10000;
  let turn;
  do {
    turn = await session.getTurn(turnId);
    if (turn.status !== "running") break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(turn.status, "interrupted");
  assert.equal(turn.assistantMessage, null);
  assert.deepEqual((await session.listInteractions()).interactions, []);
});

test("the installed prerecorded-audio example returns the actual saved answer", async () => {
  const session = await newSession();
  const result = await submitAudioWorkflow({
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    sessionId: session.id,
    ...recording(),
  });
  assert.equal(result.text, "Audio final answer.");
  assert.equal(
    (await session.getTurn(result.turnId)).assistantMessage.id,
    result.messageId,
  );
});
