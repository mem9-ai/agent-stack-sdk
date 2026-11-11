import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";

test("the actual unconfigured transcription deployment refuses audio explicitly", async () => {
  const user = new OrganizationClient({
  baseUrl: process.env.SDK_SERVICE_URL,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
}).user(process.env.SDK_USER_ID);
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
