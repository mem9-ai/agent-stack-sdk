import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";
import { createSessionWorkflow } from "@tidblink/server/examples/create-session.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const organization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
});
const otherOrganization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_OTHER_ORGANIZATION_KEY,
});
const stage = (stage, userId) =>
  new Promise((resolve, reject) => {
    process.once("message", ({ value, error }) =>
      error ? reject(new Error(error)) : resolve(value),
    );
    process.send({ stage, userId });
  });
const until = async (read, matches) => {
  const end = Date.now() + 20000;
  do {
    const value = await read();
    if (matches(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Compiled SDK journey did not reach the expected state");
};
const unauthorized = (error) =>
  error instanceof TiDBLinkApiError && error.status === 401;
const user = await organization.createEndUser({
  externalId: `sdk_${randomUUID()}`,
  displayName: "SDK owner",
});
assert.equal(
  (await organization.getEndUser(user.userId)).userId,
  user.userId,
);
const owner = organization.user(user.userId);
const other = otherOrganization.user(user.userId);
const creation = {
  baseUrl,
  organizationApiKey: process.env.SDK_ORGANIZATION_KEY,
  userId: user.userId,
  agentTemplateId: process.env.SDK_TEMPLATE_ID,
  agentCreationKey: randomUUID(),
  sessionCreationKey: randomUUID(),
};
const { agent, session } = await createSessionWorkflow(creation);
assert.equal(
  (await createSessionWorkflow(creation)).session.id,
  session.id,
);
assert.equal(agent.data.ownerUserId, user.userId);
await agent.update({ additionalInstructions: "Be concise" });
assert.equal(
  (await owner.getAgent(agent.id)).data.additionalInstructions,
  "Be concise",
);
await session.rename("SDK Organization journey");
assert(
  (await owner.listSessions()).sessions.some(
    (item) => item.id === session.id,
  ),
);
assert(
  (await owner.listRealtimeModels()).models.some(
    (item) => item.id === "voice-a",
  ),
);
const wrong = await organization.createEndUser({
  displayName: "Wrong owner",
});
await assert.rejects(
  organization.user(wrong.userId).getSession(session.id),
  (error) => error.status === 404,
);

await stage("storage", user.userId);
const bytes = Buffer.from("SDK Organization file");
const file = await owner.files.upload({
  idempotencyKey: randomUUID(),
  originalName: "note.txt",
  contentType: "text/plain",
  bytes,
});
assert.equal(file.status, "ready");
assert.deepEqual(
  Buffer.from(await owner.files.download(file.fileId)),
  bytes,
);
assert(
  (await owner.files.list()).files.some(
    (item) => item.fileId === file.fileId,
  ),
);
await stage("text");
const command = {
  clientEventId: randomUUID(),
  text: "Read this note",
  userFileIds: [file.fileId],
};
const accepted = await session.submitMessage(command);
const result = await session.waitForResult(accepted.inputId, {
  timeoutMs: 20000,
  pollIntervalMs: 25,
});
assert.equal(result.text, "Organization SDK answer.");
assert.equal(
  (await session.reconcileInteraction(command.clientEventId)).inputId,
  accepted.inputId,
);
assert.equal(
  (await session.getTurn(result.turnId)).userFiles[0].userFileId,
  file.fileId,
);
assert(
  (await session.history()).turns.some((turn) => turn.id === result.turnId),
);
assert((await session.timeline()).entries.length > 0);
for await (const event of session.events({
  signal: AbortSignal.timeout(10000),
})) {
  assert.equal(typeof event.cursor, "string");
  break;
}

await stage("tools");
const tools = await session.getClientTools();
await session.replaceClientTools(
  [
    {
      type: "function",
      name: "lookup_order",
      description: "Get order",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  { ifMatch: tools.etag },
);
const toolInput = await session.submitMessage({
  clientEventId: randomUUID(),
  text: "Look up my order",
});
const [call] = await until(
  () => session.listPendingClientToolCalls(),
  (calls) => calls.length > 0,
);
await session.submitClientToolOutput({
  clientEventId: randomUUID(),
  turnId: call.turnId,
  callId: call.callId,
  output: "SDK_ORDER_SHIPPED",
});
assert.equal(
  (
    await session.waitForResult(toolInput.inputId, {
      timeoutMs: 20000,
      pollIntervalMs: 25,
    })
  ).text,
  "Order shipped.",
);
await until(
  () => session.refresh(),
  (current) => current.data.activeTurnId === null,
);
// An Organization registers and activates an HTTP Connector, and an Agent calls it.
const { createConnectorHandler } = await import(
  "@tidblink/server/examples/http-connector.mjs"
);
const { organizationId } = await organization.getOrganization();
let connector = await organization.connectors.register({
  displayName: "SDK Orders",
  endpointUrl: process.env.SDK_CONNECTOR_ENDPOINT,
});
assert.equal(connector.status, "inactive");
assert.equal(connector.transport, "streamable_http");
const connectorCalls = [];
const connectorServer = createServer(
  createConnectorHandler({
    baseUrl,
    organizationId,
    connectorId: connector.connectorId,
    name: "SDK Orders",
    tools: {
      lookup_order: {
        description: "Look up one of the user's orders",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
        run: async ({ orderId }, context) => {
          connectorCalls.push({ orderId, context });
          return `SDK_CONNECTOR_RESULT ${orderId}`;
        },
      },
    },
  }),
);
await new Promise((resolve) =>
  connectorServer.listen(Number(process.env.SDK_CONNECTOR_PORT), "127.0.0.1", resolve),
);
try {
  connector = await organization.connectors.activate(connector.connectorId, {
    expectedConnectorVersion: connector.connectorVersion,
  });
  assert.equal(connector.status, "active");
  assert(connector.observation);
  assert(
    (await organization.connectors.list()).some(
      (item) => item.connectorId === connector.connectorId,
    ),
  );
  // Another Key of the same Organization manages the same registration.
  assert.equal(
    (await otherOrganization.connectors.get(connector.connectorId)).status,
    "active",
  );
  const connectorTemplateId = await stage("connector", connector.connectorId);
  const connectorAgent = await owner.createAgent({
    agentTemplateId: connectorTemplateId,
    idempotencyKey: randomUUID(),
  });
  const connectorSession = await connectorAgent.createSession({
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    (
      await connectorSession.turn(
        { clientEventId: randomUUID(), text: "Where is order 7?" },
        { timeoutMs: 20000, pollIntervalMs: 25 },
      )
    ).text,
    "Connector order shipped.",
  );
  assert.equal(connectorCalls.length, 1);
  assert.equal(connectorCalls[0].orderId, "order_7");
  assert.equal(connectorCalls[0].context.userId, user.userId);
  assert.equal(connectorCalls[0].context.sessionId, connectorSession.id);
  assert.equal(connectorCalls[0].context.organizationId, organizationId);
  connector = await organization.connectors.deactivate(connector.connectorId, {
    expectedConnectorVersion: connector.connectorVersion,
  });
  assert.equal(connector.status, "inactive");
} finally {
  connectorServer.closeAllConnections();
  await new Promise((resolve) => connectorServer.close(resolve));
}

await stage("audio");
const wav = Buffer.alloc(364);
wav.write("RIFF", 0);
wav.writeUInt32LE(356, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(320, 40);
assert.equal(
  (
    await session.audio({
      filename: "voice.wav",
      contentType: "audio/wav",
      bytes: wav,
    })
  ).text,
  "SDK audio answer.",
);
await until(
  () => session.refresh(),
  (current) => current.data.activeTurnId === null,
);


await until(
  () => session.refresh(),
  (current) => current.data.activeTurnId === null,
);
const realtime = await session.openRealtimeConnection();
assert.equal(realtime.realtimeConnection.status, "connecting");
assert((await session.createRealtimeConnectToken()).connectToken);
assert.equal(
  (await session.getRealtimeConnection()).id,
  realtime.realtimeConnection.id,
);
await stage("pause");
const inFlight = await session.submitMessage({
  clientEventId: randomUUID(),
  text: "Finish accepted work",
});
const freshKey = await stage("rotate");
await assert.rejects(owner.listAgents(), unauthorized);
const freshOrganization = new OrganizationClient({
  baseUrl,
  apiKey: freshKey,
});
const fresh = freshOrganization.user(user.userId);
const recoveredSession = fresh.session(session.id);
assert.equal(
  (
    await recoveredSession.waitForResult(inFlight.inputId, {
      timeoutMs: 20000,
      pollIntervalMs: 25,
    })
  ).text,
  "Accepted work survived rotation.",
);
assert.equal((await other.getSession(session.id)).id, session.id);
assert.equal((await recoveredSession.getRealtimeConnection()).status, "ended");
const reopened = await recoveredSession.openRealtimeConnection();
assert.notEqual(
  reopened.realtimeConnection.id,
  realtime.realtimeConnection.id,
);
await recoveredSession.endRealtimeConnection();
assert.deepEqual(
  Buffer.from(await fresh.files.download(file.fileId)),
  bytes,
);
const now = new Date();
await freshOrganization.getUserUsageDetails(user.userId, {
  from: new Date(now.getTime() - 3600000).toISOString(),
  to: now.toISOString(),
});
await stage("revoke");
await assert.rejects(fresh.listAgents(), unauthorized);
assert.equal((await other.getSession(session.id)).id, session.id);
console.log(
  "Packed Organization consumer passed: provisioning, discovery, creation replay, ownership, file transfer/attachment, text/SSE/history, Client Tools, audio, Realtime HTTP, and rotation/revocation recovery.",
);
process.disconnect();
