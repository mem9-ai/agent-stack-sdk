import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { UserClient, TiDBLinkApiError } from "@mem9/tidb-link";

test("the actual unconfigured transcription deployment refuses audio explicitly", async () => {
  const user = new UserClient({
    baseUrl: process.env.SDK_SERVICE_URL,
    apiKey: process.env.SDK_USER_KEY,
  });
  const agent = await user.createAgent({
    agentTemplateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });
  const session = await agent.createSession({ idempotencyKey: randomUUID() });
  await assert.rejects(
    session.audio({
      filename: "voice.wav",
      bytes: new Uint8Array([1]),
      contentType: "audio/wav",
    }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.status === 501 &&
      error.code === "asr_disabled",
  );
});
