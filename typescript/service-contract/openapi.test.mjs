import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const expectedRevision = "0d11f1b231879c735bd53b60ff895ac58ba60d33";
const expectedSourceSha256 =
  "ce6ac6c2b1e2e50461455a85eb4aedffd8958019d15ef95e6b8254eaef54a9dc";
const openApiBytes = await readFile(new URL("openapi.json", import.meta.url));
const document = JSON.parse(openApiBytes);
const metadata = JSON.parse(
  await readFile(new URL("metadata.json", import.meta.url), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const sessionPath = "/api/v1/user/sessions/{id}";
const schema = (name) => {
  const value = document.components.schemas[name];
  assert(value, `missing schema ${name}`);
  return value;
};
const properties = (value) => {
  if (value.$ref) return properties(schema(value.$ref.split("/").at(-1)));
  return value.properties ?? {};
};

test("text and history keep the selected immutable service contract", () => {
  assert.equal(metadata.tidbLinkRevision, expectedRevision);
  assert.equal(metadata.tidbLinkApiVersion, "0.0.1");
  assert.equal(metadata.sourceOpenApiSha256, expectedSourceSha256);
  assert.equal(packageJson.tidbLinkTextRevision, metadata.tidbLinkRevision);
  assert.equal(
    packageJson.tidbLinkTextOpenApiSha256,
    metadata.sourceOpenApiSha256,
  );
  assert.equal(packageJson.tidbLinkApiVersion, metadata.tidbLinkApiVersion);
  assert.equal(
    createHash("sha256").update(openApiBytes).digest("hex"),
    metadata.sha256,
  );
});

test("the selected commands and history reads require User authority", () => {
  const operations = [
    ["/events", "post"],
    ["/interactions", "get"],
    ["/interactions/{receiptId}", "get"],
    ["/turns", "get"],
    ["/turns/{turnId}", "get"],
    ["/timeline", "get"],
    ["/tools", "get"],
    ["/tools", "put"],
    ["/client-tool-calls", "get"],
  ];
  for (const [route, method] of operations) {
    const operation = document.paths[`${sessionPath}${route}`][method];
    assert.deepEqual(operation.security, [{ UserApiKey: [] }]);
  }
  const credential = document.components.securitySchemes.UserApiKey;
  assert.equal(credential.type, "http");
  assert.equal(credential.scheme, "bearer");
  const submission = document.paths[`${sessionPath}/events`].post;
  assert.equal(
    submission.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/SessionEventOpenApiDto",
  );
  for (const status of ["200", "202"])
    assert(
      submission.responses[status].content[
        "application/json"
      ].schema.oneOf.some(
        (variant) =>
          variant.$ref ===
          "#/components/schemas/SessionInteractionResponseOpenApiDto",
      ),
    );
});

test("message identities, incorporation and original outcomes remain distinct", () => {
  const command = schema("SessionEventOpenApiDto").oneOf.find((variant) =>
    properties(variant).type.enum.includes("agent.session.input.message"),
  );
  assert.deepEqual(command.required, ["type", "clientEventId", "data"]);
  assert.equal(command.additionalProperties, false);
  assert.equal(
    properties(command).clientEventId.pattern,
    "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
  );
  const input = properties(command).data.anyOf.find((variant) =>
    variant.required.includes("text"),
  );
  assert.deepEqual(Object.keys(properties(input)).sort(), [
    "billingTag",
    "clarificationSourceTurnId",
    "content",
    "text",
    "userFileIds",
  ]);
  assert.equal(properties(input).text.oneOf[1].maxItems, 9);
  assert.equal(properties(input).billingTag.nullable, true);
  const receipt = properties(
    schema("SessionInteractionResponseOpenApiDto"),
  ).interaction;
  assert.deepEqual(receipt.required, [
    "inputId",
    "sequence",
    "kind",
    "mode",
    "turnId",
    "message",
    "createdAt",
    "appliedAt",
    "rejection",
    "result",
  ]);
  const fields = properties(receipt);
  assert.equal(fields.appliedAt.nullable, true);
  assert.equal(fields.message.nullable, true);
  assert.equal(fields.rejection.nullable, true);
  assert.deepEqual(properties(fields.result).status.enum, [
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]);
  assert.equal(properties(fields.result).completedAt.nullable, true);
  const lookup = document.paths[
    `${sessionPath}/interactions`
  ].get.parameters.find(({ name }) => name === "clientEventId");
  assert(lookup);
});

test("history pages preserve Full Agent and Realtime projections", () => {
  for (const [route, responseName, collection] of [
    ["/interactions", "SessionInteractionsResponseOpenApiDto", "interactions"],
    ["/turns", "TurnsResponseOpenApiDto", "turns"],
    ["/timeline", "SessionTimelineResponseOpenApiDto", "entries"],
  ]) {
    const page = properties(schema(responseName));
    assert.equal(page[collection].type, "array");
    assert.equal(page.hasMore.type, "boolean");
    assert.equal(page.nextCursor.nullable, true);
    const parameters = document.paths[`${sessionPath}${route}`].get.parameters;
    assert(parameters.some(({ name }) => name === "cursor"));
    assert.equal(
      parameters.find(({ name }) => name === "limit").schema.maximum,
      200,
    );
  }
  const turn = properties(schema("Turn"));
  assert.deepEqual(turn.executor.enum, ["full_agent", "realtime_model"]);
  assert.equal(turn.userMessages.type, "array");
  assert.equal(turn.realtimeResponses.type, "array");
  assert.deepEqual(properties(turn.realtime).linkedTurnIds.items, {
    type: "string",
  });
  const message = properties(schema("Message"));
  assert(message.inputContext);
  assert(message.realtime);
  const entries = properties(schema("SessionTimelineResponseOpenApiDto"))
    .entries.items.oneOf;
  assert.deepEqual(
    entries.map((variant) => properties(variant).type.enum[0]),
    ["turn", "realtime"],
  );
  const facts = properties(entries[1]).realtime.oneOf;
  assert.deepEqual(
    facts.map((variant) => properties(variant).type.enum[0]),
    ["input_transcript", "response"],
  );
  assert.equal(properties(facts[1]).turnId.nullable, true);
  assert.equal(properties(facts[1]).responseId.nullable, true);
  assert.equal(properties(facts[1]).interrupted.type, "boolean");
});

test("cancel and checkpoint retry keep exact command identities and distinct receipt shapes", () => {
  for (const kind of ["cancel", "retry"]) {
    const command = schema("SessionEventOpenApiDto").oneOf.find((variant) =>
      properties(variant).type.enum.includes(`agent.session.input.${kind}`),
    );
    assert.deepEqual(command.required, ["type", "clientEventId", "data"]);
    assert.equal(
      properties(command).clientEventId.pattern,
      "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
    );
    const data = properties(command).data;
    assert.deepEqual(Object.keys(properties(data)), ["turnId"]);
    assert.equal(properties(data).turnId.maxLength, 64);
    if (kind === "retry") assert.deepEqual(data.required, ["turnId"]);
  }
  const receipt = properties(
    schema("SessionEventRetryResponseOpenApiDto"),
  ).event;
  assert.deepEqual(receipt.required, [
    "clientEventId",
    "sessionId",
    "turnId",
    "disposition",
  ]);
  assert.deepEqual(properties(receipt).disposition.enum, ["retrying"]);
  const submission = document.paths[`${sessionPath}/events`].post;
  for (const status of ["200", "202"])
    assert(
      submission.responses[status].content[
        "application/json"
      ].schema.oneOf.some(
        (variant) =>
          variant.$ref ===
          "#/components/schemas/SessionEventRetryResponseOpenApiDto",
      ),
    );
});

test("independent observation preserves the declared event position and snapshot contract", () => {
  const subscription = document.paths[`${sessionPath}/events`].get;
  assert.deepEqual(subscription.security, [{ UserApiKey: [] }]);
  assert(
    subscription.parameters.some(
      (parameter) => parameter.name === "cursor" && parameter.in === "query",
    ),
  );
  assert(
    subscription.parameters.some(
      (parameter) => parameter.name === "stream" && parameter.required,
    ),
  );
  assert(
    subscription.parameters.some(
      (parameter) =>
        parameter.name === "Accept" &&
        parameter.schema.enum.includes("text/event-stream"),
    ),
  );
  const stream = subscription.responses["200"];
  assert(stream.content["text/event-stream"]);
  assert(stream.headers);
  assert.match(stream.description, /complete provisional draft/);
  assert.match(
    stream.description,
    /Disconnecting the subscription does not cancel/,
  );
  assert.match(stream.description, /agent\.session\.turn\.requires_action/);
});

test("usage surfaces preserve separate authority, ranges and result projections", () => {
  const own = document.paths["/api/v1/billing/usage"].get;
  const org = document.paths["/api/v1/org/users/{userId}/billing/usage"].get;
  const ownDetails = document.paths["/api/v1/billing/usage/details"].get;
  const orgDetails =
    document.paths["/api/v1/org/users/{userId}/billing/usage/details"].get;
  for (const operation of [own, ownDetails])
    assert.deepEqual(operation.security, [{ UserApiKey: [] }]);
  for (const operation of [org, orgDetails])
    assert.deepEqual(operation.security, [{ OrganizationApiKey: [] }]);
  assert.equal(own.parameters.find((p) => p.name === "from").required, false);
  assert.equal(org.parameters.find((p) => p.name === "from").required, true);
  assert(
    own.parameters
      .find((p) => p.name === "from")
      .schema.pattern.includes("\\d{4}"),
  );
  assert.equal(
    org.parameters.find((p) => p.name === "from").schema.format,
    "date-time",
  );
  assert(!ownDetails.parameters.some((p) => p.name === "cursor"));
  assert(orgDetails.parameters.some((p) => p.name === "cursor"));
  const self = properties(schema("ConsoleBillingDetailsResponseOpenApiDto"));
  assert(self.llm && self.sandbox && self.webSearch && !self.nextCursor);
  const target = orgDetails.responses["200"].content["application/json"].schema;
  assert.deepEqual(target.required, [
    "items",
    "nextCursor",
    "factCompleteness",
  ]);
  const item = properties(target).items.items.oneOf.find(
    (v) => properties(v).kind.enum[0] === "llm",
  );
  assert.equal(properties(item).costMicros.nullable, true);
  assert.deepEqual(properties(item).pricingStatus.enum, [
    "estimated",
    "unknown",
  ]);
  assert.deepEqual(properties(item).valuationStatus.enum, [
    "priced",
    "unpriced",
  ]);
});

test("Client Tools preserve declaration replacement, pending deadlines and explicit result command shapes", () => {
  const create = properties(schema("CreateSessionOpenApiDto"));
  assert(create.tools);
  const replace = document.paths[`${sessionPath}/tools`].put;
  assert(
    replace.parameters.some(
      (parameter) => parameter.name === "If-Match" && parameter.required,
    ),
  );
  assert(replace.responses["412"]);
  assert(replace.responses["428"]);
  assert(replace.responses["200"].headers.ETag);
  const set = properties(schema("SessionClientToolsResponseOpenApiDto"));
  assert.equal(set.revision.type, "integer");
  assert.equal(set.tools.type, "array");
  const pending = properties(
    schema("PendingClientToolCallsResponseOpenApiDto"),
  ).calls;
  for (const key of [
    "callId",
    "turnId",
    "name",
    "arguments",
    "publishedAt",
    "deadlineAt",
  ])
    assert(properties(pending.items)[key]);
  const output = schema("SessionEventOpenApiDto").oneOf.find((variant) =>
    properties(variant).type.enum.includes(
      "agent.session.input.client_tool_output",
    ),
  );
  assert(output.required.includes("clientEventId"));
  const variants = properties(output).data.oneOf;
  assert(
    variants.some((variant) => properties(variant).output?.maxLength === 65536),
  );
  assert(variants.some((variant) => properties(variant).error));
});
