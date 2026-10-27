import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

import { UserClient } from "../dist/index.js";

const servers = [];
const userApiKey = "ti_user_" + "key_" + "x".repeat(43);

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const clientFor = (baseUrl) =>
  new UserClient({
    baseUrl,
    apiKey: userApiKey,
  });

test("a User discovers the published Realtime Models and client capabilities", async () => {
  const calls = [];
  const catalog = {
    defaultModel: "voice-default",
    models: [
      {
        id: "voice-default",
        label: "Realtime Voice",
        available: true,
        isDefault: true,
        languages: ["zh-CN", "en-US"],
        endpointingModes: ["client", "server"],
        audio: {
          input: [
            { encoding: "pcm16", sampleRate: 16000, channels: 1 },
            {
              encoding: "opus",
              sampleRate: 16000,
              channels: 1,
              packetDurationMs: 20,
            },
          ],
          output: [
            {
              encoding: "opus",
              sampleRate: 24000,
              channels: 1,
              packetDurationMs: 20,
              bitrate: 32000,
            },
          ],
        },
      },
    ],
  };
  const baseUrl = await serve((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(catalog));
  });

  assert.deepEqual(await clientFor(baseUrl).listRealtimeModels(), catalog);
  assert.deepEqual(calls, [
    {
      method: "GET",
      url: "/api/v1/realtime-models",
      authorization: `Bearer ${userApiKey}`,
    },
  ]);
});

test("a Session reads and conditionally changes its independent Realtime Model selection", async () => {
  const calls = [];
  const selection = (overrides = {}) => ({
    realtimeModel: "voice-a",
    realtimeModelRevision: 1,
    realtimeModelEtag: '"session_1-realtime-1"',
    realtimeVoice: { language: "en-US" },
    ...overrides,
  });
  let selectionUpdated = false;
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      ifMatch: request.headers["if-match"],
      idempotencyKey: request.headers["idempotency-key"],
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ session: selection() }));
      return;
    }
    if (
      request.headers["if-match"] === '"session_1-realtime-1"' &&
      !selectionUpdated
    ) {
      selectionUpdated = true;
      response.end(
        JSON.stringify({
          session: selection({
            realtimeModel: "voice-b",
            realtimeModelRevision: 2,
            realtimeModelEtag: '"session_1-realtime-2"',
          }),
        }),
      );
      return;
    }
    response.writeHead(412).end(
      JSON.stringify({
        error: {
          code: "realtime_model_conflict",
          message: "The Realtime Model selection has changed.",
        },
      }),
    );
  });
  const session = clientFor(baseUrl).session("session_1");

  const current = await session.getRealtimeModelSelection();
  assert.deepEqual(current, {
    model: "voice-a",
    revision: 1,
    etag: '"session_1-realtime-1"',
    voice: { language: "en-US" },
  });
  const updated = await session.setRealtimeModel("voice-b", {
    ifMatch: current.etag,
  });
  assert.deepEqual(updated, {
    model: "voice-b",
    revision: 2,
    etag: '"session_1-realtime-2"',
    voice: { language: "en-US" },
  });
  await assert.rejects(
    session.setRealtimeModel("voice-a", { ifMatch: current.etag }),
    (error) => error.status === 412 && error.code === "realtime_model_conflict",
  );

  assert.deepEqual(
    calls.map(({ method, url, ifMatch, idempotencyKey, body }) => ({
      method,
      url,
      ifMatch,
      idempotencyKey,
      body: body ? JSON.parse(body) : undefined,
    })),
    [
      {
        method: "GET",
        url: "/api/v1/user/sessions/session_1",
        ifMatch: undefined,
        idempotencyKey: undefined,
        body: undefined,
      },
      {
        method: "PATCH",
        url: "/api/v1/user/sessions/session_1/realtime-model",
        ifMatch: '"session_1-realtime-1"',
        idempotencyKey: undefined,
        body: { realtimeModel: "voice-b" },
      },
      {
        method: "PATCH",
        url: "/api/v1/user/sessions/session_1/realtime-model",
        ifMatch: '"session_1-realtime-1"',
        idempotencyKey: undefined,
        body: { realtimeModel: "voice-a" },
      },
    ],
  );
  assert.equal(calls.some(({ url }) => url.startsWith("/api/sessions")), false);
});

test("a Session prepares a Realtime Connection and returns its one-time connect grant", async () => {
  const calls = [];
  const connection = {
    object: "realtime_connection",
    id: "rtc_1",
    sessionId: "session_1",
    agentId: "agent_1",
    provider: { name: "qwen-omni", region: "cn-beijing", model: "qwen-live" },
    status: "connecting",
    audio: {
      input: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
      output: {
        encoding: "opus",
        sampleRate: 24000,
        channels: 1,
        packetDurationMs: 20,
        bitrate: 24000,
      },
    },
    activeTaskTurnId: null,
    usage: {
      inputAudioSec: 0,
      outputAudioSec: 0,
      thoughtTokens: 0,
      textTokens: 0,
    },
    metadata: { terminal: "kiosk-1" },
    createdAt: "2026-10-27T12:00:00.000Z",
    endedAt: null,
  };
  const result = {
    realtimeConnection: connection,
    websocketUrl: "wss://voice.example/api/v1/user/sessions/session_1/realtime/ws",
    connectToken: "rct_" + "a".repeat(43),
    connectTokenExpiresAt: "2026-10-27T12:01:00.000Z",
  };
  const baseUrl = await serve(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers["idempotency-key"],
      body: JSON.parse(body),
    });
    response.setHeader("content-type", "application/json");
    response.writeHead(201).end(JSON.stringify(result));
  });
  const session = clientFor(baseUrl).session("session_1");

  assert.deepEqual(
    await session.openRealtimeConnection({
      audio: { output: connection.audio.output },
      metadata: { terminal: "kiosk-1" },
    }),
    result,
  );
  assert.deepEqual(calls, [
    {
      method: "POST",
      url: "/api/v1/user/sessions/session_1/realtime",
      idempotencyKey: undefined,
      body: {
        audio: { output: connection.audio.output },
        metadata: { terminal: "kiosk-1" },
      },
    },
  ]);
});

const realtimeConnection = (overrides = {}) => ({
  object: "realtime_connection",
  id: "rtc_1",
  sessionId: "session_1",
  agentId: "agent_1",
  provider: { name: "qwen-omni", region: "cn-beijing", model: "qwen-live" },
  status: "connecting",
  audio: {
    input: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
    output: { encoding: "pcm16", sampleRate: 24000, channels: 1 },
  },
  activeTaskTurnId: null,
  usage: { inputAudioSec: 0, outputAudioSec: 0, thoughtTokens: 0, textTokens: 0 },
  metadata: {},
  createdAt: "2026-10-27T12:00:00.000Z",
  endedAt: null,
  ...overrides,
});

test("a Session inspects its newest Realtime Connection", async () => {
  const calls = [];
  const connection = realtimeConnection();
  const baseUrl = await serve((request, response) => {
    calls.push([request.method, request.url]);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ realtimeConnection: connection }));
  });

  assert.deepEqual(
    await clientFor(baseUrl).session("session_1").getRealtimeConnection(),
    connection,
  );
  assert.deepEqual(calls, [
    ["GET", "/api/v1/user/sessions/session_1/realtime"],
  ]);
});

test("a Session requests a fresh one-time Realtime connect token", async () => {
  const calls = [];
  const grant = {
    websocketUrl: "wss://voice.example/api/v1/user/sessions/session_1/realtime/ws",
    connectToken: "rct_" + "b".repeat(43),
    connectTokenExpiresAt: "2026-10-27T12:01:00.000Z",
  };
  const baseUrl = await serve((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers["idempotency-key"],
    });
    response.setHeader("content-type", "application/json");
    response.writeHead(201).end(JSON.stringify(grant));
  });

  assert.deepEqual(
    await clientFor(baseUrl).session("session_1").createRealtimeConnectToken(),
    grant,
  );
  assert.deepEqual(calls, [
    {
      method: "POST",
      url: "/api/v1/user/sessions/session_1/realtime/connect-tokens",
      idempotencyKey: undefined,
    },
  ]);
});

test("a Session ends and returns its newest Realtime Connection without replaying it", async () => {
  const calls = [];
  const connection = realtimeConnection({
    status: "ended",
    endedAt: "2026-10-27T12:02:00.000Z",
  });
  const baseUrl = await serve((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      idempotencyKey: request.headers["idempotency-key"],
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ realtimeConnection: connection }));
  });

  assert.deepEqual(
    await clientFor(baseUrl).session("session_1").endRealtimeConnection(),
    connection,
  );
  assert.deepEqual(calls, [
    {
      method: "DELETE",
      url: "/api/v1/user/sessions/session_1/realtime",
      idempotencyKey: undefined,
    },
  ]);
});

for (const [name, invoke, expected] of [
  [
    "Realtime Model selection",
    (session) => session.setRealtimeModel("voice-b", { ifMatch: '"realtime-v1"' }),
    ["PATCH", "/api/v1/user/sessions/session_1/realtime-model"],
  ],
  [
    "Realtime Connection preparation",
    (session) => session.openRealtimeConnection(),
    ["POST", "/api/v1/user/sessions/session_1/realtime"],
  ],
  [
    "Realtime connect-token issuance",
    (session) => session.createRealtimeConnectToken(),
    ["POST", "/api/v1/user/sessions/session_1/realtime/connect-tokens"],
  ],
  [
    "Realtime Connection termination",
    (session) => session.endRealtimeConnection(),
    ["DELETE", "/api/v1/user/sessions/session_1/realtime"],
  ],
]) {
  test(`a lost ${name} response is not replayed`, async () => {
    const calls = [];
    const unreturnedToken = "rct_unreturned-secret";
    const baseUrl = await serve(async (request) => {
      for await (const _chunk of request) {
        // Wait until the complete request reached the server before losing the response.
      }
      calls.push({
        method: request.method,
        url: request.url,
        requestId: request.headers["x-request-id"],
        idempotencyKey: request.headers["idempotency-key"],
      });
      void unreturnedToken;
      request.socket.destroy();
    });

    await assert.rejects(
      invoke(clientFor(baseUrl).session("session_1")),
      (error) => {
        assert.equal(error.name, "OutcomeUnknownError");
        assert.equal(error.requestId, calls[0].requestId);
        assert.doesNotMatch(String(error), /rct_unreturned-secret/);
        assert.doesNotMatch(JSON.stringify(error), /rct_unreturned-secret/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      [calls[0].method, calls[0].url],
      expected,
    );
    assert.equal(calls[0].idempotencyKey, undefined);
  });
}

for (const [name, invoke] of [
  [
    "Realtime Model selection",
    (session) => session.setRealtimeModel("voice-b", { ifMatch: '"realtime-v1"' }),
  ],
  ["Realtime Connection preparation", (session) => session.openRealtimeConnection()],
  ["Realtime connect-token issuance", (session) => session.createRealtimeConnectToken()],
  ["Realtime Connection termination", (session) => session.endRealtimeConnection()],
]) {
  test(`an unusable successful ${name} response is outcome unknown`, async () => {
    const calls = [];
    const returnedToken = "rct_" + "s".repeat(43);
    const baseUrl = await serve(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the mutation before returning an unusable success receipt.
      }
      calls.push([request.method, request.url]);
      response.setHeader("content-type", "application/json");
      response.setHeader("x-request-id", "service-receipt-id");
      if (name === "Realtime Model selection") {
        response.writeHead(204).end();
      } else if (name === "Realtime connect-token issuance") {
        response.writeHead(201).end(
          JSON.stringify({
            websocketUrl: "not-a-websocket-url",
            connectToken: returnedToken,
            connectTokenExpiresAt: "2026-10-27T12:01:00.000Z",
          }),
        );
      } else {
        response.writeHead(request.method === "POST" ? 201 : 200).end("{}");
      }
    });

    await assert.rejects(
      invoke(clientFor(baseUrl).session("session_1")),
      (error) => {
        assert.equal(error.name, "OutcomeUnknownError");
        assert.equal(error.requestId, "service-receipt-id");
        assert.doesNotMatch(String(error), /rct_/u);
        assert.equal(JSON.stringify(error).includes(returnedToken), false);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });
}