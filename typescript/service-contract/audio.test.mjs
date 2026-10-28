import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("audio.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);

test("prerecorded audio keeps its multipart request and distinct response-owned event contract", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "eefa54403906c10db59831cc66f84627c038756d9ade1d5cbbb3d16597b8287d",
  );
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(
    contract.sourceOpenApiSha256,
    manifest.tidbLinkTextOpenApiSha256,
  );
  const operation =
    contract.paths["/api/v1/user/sessions/{id}/turns/audio"].post;
  assert.deepEqual(operation.security, [{ UserApiKey: [] }]);
  const multipart = operation.requestBody.content["multipart/form-data"];
  assert.deepEqual(multipart.schema.required, ["file"]);
  assert.deepEqual(Object.keys(multipart.schema.properties).sort(), [
    "billingTag",
    "file",
  ]);
  assert.equal(multipart.schema.properties.file.format, "binary");
  assert.equal(multipart.encoding.billingTag.contentType, "application/json");
  assert.equal(multipart.schema.properties.billingTag.nullable, true);
  const success = operation.responses["201"];
  assert.equal(
    success.content["text/event-stream"].schema["x-sse-event-schema"].$ref,
    "#/components/schemas/TurnStreamEvent",
  );
  assert.deepEqual(success.headers["Cache-Control"].schema.enum, [
    "no-cache, no-transform",
  ]);
  for (const status of ["409", "429", "501"])
    assert(operation.responses[status]);
  const events = contract.components.schemas.TurnStreamEvent.oneOf;
  assert.deepEqual(
    events.map((event) => event.properties.event.enum[0]).sort(),
    [
      "assistant_draft",
      "assistant_message",
      "operation_step",
      "progress",
      "turn_error",
      "turn_finished",
      "turn_started",
    ],
  );
  for (const event of events)
    assert.deepEqual(event.required, [
      "event",
      "turnId",
      "sessionId",
      "seq",
      "createdAt",
      "payload",
    ]);
  const started = events.find(
    (event) => event.properties.event.enum[0] === "turn_started",
  );
  assert(!(started.properties.payload.required ?? []).includes("inputId"));
  const terminal = events.find(
    (event) => event.properties.event.enum[0] === "turn_finished",
  );
  assert.deepEqual(terminal.properties.payload.properties.status.enum, [
    "succeeded",
    "failed",
    "interrupted",
  ]);
});
