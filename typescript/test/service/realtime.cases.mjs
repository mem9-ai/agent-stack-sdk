import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ConflictError,
  TiDBLinkApiError,
  UserClient,
} from "@mem9/tidb-link";

const exec = promisify(execFile);
const baseUrl = process.env.SDK_SERVICE_URL;
const userApiKey = process.env.SDK_USER_KEY;
const foreignUserApiKey = process.env.SDK_FOREIGN_USER_KEY;
const organizationApiKey = process.env.SDK_ORGANIZATION_KEY;
const sessionId = process.env.SDK_REALTIME_SESSION_ID;
const exampleSessionId = process.env.SDK_REALTIME_EXAMPLE_SESSION_ID;
const disabledSessionId = process.env.SDK_REALTIME_DISABLED_SESSION_ID;
assert(
  baseUrl &&
    userApiKey &&
    foreignUserApiKey &&
    organizationApiKey &&
    sessionId &&
    exampleSessionId &&
    disabledSessionId,
  "Run this suite through npm run test:service",
);

const refusal = (status, code) => (error) =>
  error instanceof TiDBLinkApiError &&
  error.status === status &&
  error.code === code &&
  typeof error.requestId === "string" &&
  error.requestId.length > 0;
const expiresSoon = (value) => {
  const milliseconds = Date.parse(value) - Date.now();
  assert(milliseconds > 0, `${value} must be in the future`);
  assert(milliseconds <= 60_000, `${value} must be at most 60 seconds away`);
};
const assertNoConnectToken = (value, ...tokens) => {
  const serialized = JSON.stringify(value);
  assert.equal("connectToken" in value, false);
  for (const token of tokens) assert.equal(serialized.includes(token), false);
};

test("the installed SDK discovers, selects and manages Realtime Connections", async () => {
  const user = new UserClient({ baseUrl, apiKey: userApiKey });
  const foreign = new UserClient({ baseUrl, apiKey: foreignUserApiKey });
  const catalog = await user.listRealtimeModels();
  assert.equal(catalog.defaultModel, "voice-a");
  assert.deepEqual(
    catalog.models.map(({ id, available, isDefault }) => ({
      id,
      available,
      isDefault,
    })),
    [
      { id: "voice-a", available: true, isDefault: true },
      { id: "voice-b", available: true, isDefault: false },
      { id: "voice-unavailable", available: false, isDefault: false },
    ],
  );
  assert(
    catalog.models.every(
      (model) =>
        model.languages.includes("en-US") &&
        model.endpointingModes.length > 0 &&
        model.audio.input.length > 0 &&
        model.audio.output.length > 0,
    ),
  );
  assert.equal(JSON.stringify(catalog).includes("fictional-sdk-workspace"), false);

  const session = user.session(sessionId);
  const initial = await session.getRealtimeModelSelection();
  assert.deepEqual(initial, {
    model: "voice-a",
    revision: 1,
    etag: initial.etag,
    voice: { language: "en-US" },
  });
  assert.equal(typeof initial.etag, "string");
  assert(initial.etag.length > 0);

  const opened = await session.openRealtimeConnection({
    metadata: { terminal: "sdk-controlled" },
  });
  assert.match(opened.connectToken, /^rct_/u);
  expiresSoon(opened.connectTokenExpiresAt);
  assert.match(
    opened.websocketUrl,
    new RegExp(
      `^ws://[^/]+/api/v1/user/sessions/${sessionId}/realtime/ws$`,
      "u",
    ),
  );
  assert.deepEqual(opened.realtimeConnection, {
    ...opened.realtimeConnection,
    object: "realtime_connection",
    sessionId,
    provider: { name: "qwen-omni", region: "cn-beijing", model: "provider-a" },
    status: "connecting",
    activeTaskTurnId: null,
    metadata: { terminal: "sdk-controlled" },
    endedAt: null,
  });
  assert.equal(opened.realtimeConnection.audio.input.channels, 1);
  assert.equal(opened.realtimeConnection.audio.output.channels, 1);
  assert.deepEqual(opened.realtimeConnection.usage, {
    inputAudioSec: 0,
    outputAudioSec: 0,
    thoughtTokens: 0,
    textTokens: 0,
  });

  const selected = await session.setRealtimeModel("voice-b", {
    ifMatch: initial.etag,
  });
  assert.equal(selected.model, "voice-b");
  assert.equal(selected.revision, initial.revision + 1);
  assert.notEqual(selected.etag, initial.etag);
  await assert.rejects(
    session.setRealtimeModel("voice-a", { ifMatch: initial.etag }),
    (error) =>
      error instanceof ConflictError &&
      refusal(412, "realtime_model_conflict")(error),
  );

  const stillModelA = await session.getRealtimeConnection();
  assert.equal(stillModelA.id, opened.realtimeConnection.id);
  assert.equal(stillModelA.provider.model, "provider-a");
  assertNoConnectToken(stillModelA, opened.connectToken);
  await assert.rejects(session.openRealtimeConnection(), (error) => {
    assert(refusal(409, "realtime_connection_live")(error));
    assert.deepEqual(error.details, [
      {
        path: "/",
        reason: `live realtime connection ${opened.realtimeConnection.id}`,
      },
    ]);
    return true;
  });

  const secondGrant = await session.createRealtimeConnectToken();
  assert.match(secondGrant.connectToken, /^rct_/u);
  assert.notEqual(secondGrant.connectToken, opened.connectToken);
  expiresSoon(secondGrant.connectTokenExpiresAt);
  assert.equal(secondGrant.websocketUrl, opened.websocketUrl);

  await assert.rejects(
    foreign.session(sessionId).getRealtimeModelSelection(),
    refusal(404, "session_not_found"),
  );
  await assert.rejects(
    foreign.session(sessionId).getRealtimeConnection(),
    refusal(404, "session_not_found"),
  );

  const ended = await session.endRealtimeConnection();
  assert.equal(ended.id, opened.realtimeConnection.id);
  assert.equal(ended.status, "ended");
  assert.equal(typeof ended.endedAt, "string");
  assertNoConnectToken(ended, opened.connectToken, secondGrant.connectToken);
  const readEnded = await session.getRealtimeConnection();
  assert.deepEqual(readEnded, ended);
  assertNoConnectToken(readEnded, opened.connectToken, secondGrant.connectToken);
  await assert.rejects(
    session.createRealtimeConnectToken(),
    refusal(409, "realtime_connection_ended"),
  );

  const reopened = await session.openRealtimeConnection();
  assert.notEqual(reopened.realtimeConnection.id, ended.id);
  assert.equal(reopened.realtimeConnection.provider.model, "provider-b");
  assert.equal((await session.getRealtimeConnection()).id, reopened.realtimeConnection.id);
  await session.endRealtimeConnection();

  const latest = await session.getRealtimeModelSelection();
  const unavailable = await session.setRealtimeModel("voice-unavailable", {
    ifMatch: latest.etag,
  });
  assert.equal(unavailable.model, "voice-unavailable");
  await assert.rejects(
    session.openRealtimeConnection(),
    refusal(409, "realtime_model_unavailable"),
  );
  await assert.rejects(
    user.session(disabledSessionId).openRealtimeConnection(),
    refusal(409, "realtime_not_enabled"),
  );

  const wrongAuthority = await fetch(new URL("/api/v1/realtime-models", baseUrl), {
    headers: { authorization: `Bearer ${organizationApiKey}` },
  });
  assert.equal(wrongAuthority.status, 403);
  assert.equal((await wrongAuthority.json()).error.code, "user_api_key_required");

  const executable = import.meta.resolve(
    "@mem9/tidb-link/examples/prepare-realtime-connection.mjs",
  );
  const result = await exec(process.execPath, [fileURLToPath(executable)], {
    env: {
      ...process.env,
      AGENT_SERVICE_URL: baseUrl,
      USER_API_KEY: userApiKey,
      SESSION_ID: exampleSessionId,
      REALTIME_MODEL_ID: "voice-b",
    },
  });
  assert.equal((result.stdout + result.stderr).includes("rct_"), false);
  const output = JSON.parse(result.stdout);
  assert.equal(output.realtimeConnection.sessionId, exampleSessionId);
  assert.equal(output.realtimeConnection.provider.model, "provider-b");
  assert.equal("connectToken" in output, false);
  assert.equal(typeof output.connectTokenExpiresAt, "string");
  await user.session(exampleSessionId).endRealtimeConnection();
});
