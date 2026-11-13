import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("backend-connection.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const metadata = JSON.parse(
  await readFile(new URL("metadata.json", import.meta.url)),
);
const { schema } = contract;
const definitions = schema.definitions;
const params = (name) => definitions[name].properties.params;

test("the Backend Connection protocol snapshot is the pinned service's", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.snapshots["backend-connection.json"],
  );
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(schema["x-path"], "/api/v1/org/backend/ws");
  assert.equal(schema["x-subprotocol"], "tidb-link.backend.v1");
  assert.match(schema.description, /Authorization header/);
  // The SDK treats only an invalid Key as final.
  assert.match(schema["x-close-codes"]["4001"], /Organization API Key/);
  assert.match(schema["x-close-codes"]["1012"], /connection\.drain/);
  assert.equal(
    definitions.ApplicationServerMessage.oneOf[0].properties.id.maxLength,
    256,
  );
});

test("hello announces what the transport reads", () => {
  assert.deepEqual(params("Hello").required, [
    "connectionId",
    "maxSessions",
    "claimWindowMs",
    "heartbeatMs",
    "maxFrameBytes",
  ]);
  assert.match(params("Hello").properties.heartbeatMs.description, /ping/);
});

test("JSON-RPC errors carry the refusal reasons the SDK reacts to", () => {
  const error = definitions.ErrorResponse.properties.error;
  assert.deepEqual(error.properties.code.enum, [
    -32700, -32600, -32601, -32602, -32603, -32000,
  ]);
  for (const reason of [
    "connection_full",
    "connection_draining",
    "session_not_found",
    "authentication_required",
  ])
    assert(error.properties.data.properties.reason.enum.includes(reason), reason);
  // A request the core does not serve is answered, which the liveness probe relies on.
  assert.match(schema["x-error-codes"]["-32601"], /Method not found/);
});

test("attach, detach and the core's connection notices keep the shape the pool uses", () => {
  const attach = params("SessionAttachRequest");
  assert.deepEqual(attach.required, ["userId", "sessionId"]);
  assert.deepEqual(Object.keys(attach.properties).sort(), [
    "cursor",
    "kind",
    "sessionId",
    "tools",
    "userId",
  ]);
  assert.deepEqual(attach.properties.kind.enum, ["executing", "observing"]);
  assert.equal(attach.properties.cursor.pattern, "^(0|[1-9][0-9]{0,14})$");
  assert.deepEqual(
    definitions.SessionAttachResponse.properties.result.required,
    ["generation", "cursor"],
  );
  assert.deepEqual(params("SessionDetachRequest").required, ["sessionId"]);
  assert.deepEqual(params("ConnectionDrain").required, ["closeAfterMs"]);
  assert.deepEqual(params("SessionDetached").properties.reason.enum, [
    "superseded",
    "session_deleted",
  ]);
  // Refusals that send the attach to another connection.
  assert.match(schema["x-error-codes"]["-32000"], /connection_full/);
  assert.match(schema["x-error-codes"]["-32000"], /connection_draining/);
  assert.match(schema["x-error-codes"]["-32603"], /retry/);
});

test("session.event carries the subscription's envelope with its cursor", () => {
  const event = params("SessionEvent");
  assert.deepEqual(event.required, ["sessionId", "cursor", "event"]);
  assert.deepEqual(event.properties.event.required, [
    "type",
    "sessionId",
    "turnId",
    "createdAt",
    "data",
  ]);
  assert.match(definitions.SessionEvent.description, /strictly in order/);
});
