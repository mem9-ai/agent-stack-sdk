import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const expectedServiceRevision = "8703fc32ac89fcb59f1e583f9f95ecaaa84dd501";
const expectedContractCommit = "1aed4e709df232e330f003de5e394a5420d91d60";
const stableIdentityPattern = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$";
const contractRoot = process.env.TIDB_LINK_CONTRACT;
if (!contractRoot) throw new Error("TIDB_LINK_CONTRACT is required");
const openApiBytes = await readFile(path.join(contractRoot, "openapi.json"));
const document = JSON.parse(openApiBytes);
const metadata = JSON.parse(await readFile(path.join(contractRoot, "metadata.json"), "utf8"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const schema = (name) => {
  const value = document.components?.schemas?.[name];
  assert(value, `missing schema ${name}`);
  return value;
};
const resolve = (value) => value.$ref ? schema(value.$ref.split("/").at(-1)) : value;
const properties = (value) => {
  const resolved = resolve(value);
  return resolved.properties ?? Object.assign({}, ...(resolved.allOf ?? []).map(properties));
};
const exactProperties = (value, expected, required = expected) => {
  assert.deepEqual(Object.keys(properties(value)).sort(), [...expected].sort());
  assert.deepEqual([...(resolve(value).required ?? [])].sort(), [...required].sort());
};
const operation = (route, method, security = "UserApiKey") => {
  const value = document.paths[route]?.[method];
  assert(value, `missing ${method.toUpperCase()} ${route}`);
  assert.deepEqual(value.security, [{ [security]: [] }]);
  for (const parameter of value.parameters ?? []) {
    assert(!/target-organization|acting-user/i.test(parameter.name ?? ""));
  }
  return value;
};
const responseSchema = (route, method, status, media = "application/json") => {
  const response = operation(route, method).responses[status];
  assert(response, `missing ${status} for ${method.toUpperCase()} ${route}`);
  assert.deepEqual(Object.keys(response.content ?? {}), [media], `${status} ${route} content type`);
  return response.content[media].schema;
};
const requestSchema = (route, method) => {
  const body = operation(route, method).requestBody;
  assert.equal(body.required, true);
  assert.deepEqual(Object.keys(body.content), ["application/json"]);
  return body.content["application/json"].schema;
};
const noStore = (route, method) => {
  assert.equal(operation(route, method).responses[200].headers["Cache-Control"].schema.example, "no-store");
};
const propertyNames = (value, names = new Set(), seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return names;
  seen.add(value);
  for (const [name, nested] of Object.entries(value.properties ?? {})) {
    names.add(name);
    propertyNames(nested, names, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const nested of value[key] ?? []) propertyNames(nested, names, seen);
  }
  if (value.items) propertyNames(value.items, names, seen);
  if (value.$ref) propertyNames(resolve(value), names, seen);
  return names;
};

test("the SDK declaration maps to one immutable TiDB Link contract", async () => {
  for (const name of ["ci.yml", "release-typescript.yml"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
    const pin = workflow.match(/^  TIDB_LINK_CONTRACT_COMMIT: ([a-f0-9]{40})$/m)?.[1];
    assert.equal(pin, expectedContractCommit, `${name} immutable contract pin`);
  }
  assert.equal(metadata.tidbLinkRevision, expectedServiceRevision);
  assert.equal(metadata.tidbLinkApiVersion, "0.0.1");
  assert.equal(document.info.title, "TiDB Link Customer API");
  assert.equal(document.info.version, metadata.tidbLinkApiVersion);
  assert.equal(packageJson.tidbLinkRevision, metadata.tidbLinkRevision);
  assert.equal(packageJson.tidbLinkApiVersion, metadata.tidbLinkApiVersion);
  assert.equal(createHash("sha256").update(openApiBytes).digest("hex"), metadata.sha256);
  assert.match(metadata.sourceOpenApiSha256, /^[a-f0-9]{64}$/);
});

test("Organization admission uses key-derived authority and retains the one-time key lifecycle", () => {
  const schemes = document.components.securitySchemes;
  assert.deepEqual(Object.keys(schemes).sort(), ["OrganizationApiKey", "UserApiKey"]);
  for (const [name, prefix] of [["OrganizationApiKey", "org"], ["UserApiKey", "user"]]) {
    assert.equal(schemes[name].type, "http");
    assert.equal(schemes[name].scheme, "bearer");
    assert.equal(schemes[name].bearerFormat, "opaque");
    assert(schemes[name].description.includes(`ti_${prefix}_<id>_<secret>`));
    assert.match(schemes[name].description, /ASCII alphanumeric id body \(1–64\)/);
    assert.match(schemes[name].description, /unpadded base64url secret \(43 characters/);
  }
  for (const [route, method, status] of [
    ["/api/v1/organization", "get", 200],
    ["/api/v1/organization/users", "post", 201],
    ["/api/v1/organization/users", "get", 200],
    ["/api/v1/organization/users/{userId}", "get", 200],
    ["/api/v1/organization/users/{userId}/api-keys", "post", 201],
    ["/api/v1/organization/users/{userId}/api-keys", "get", 200],
    ["/api/v1/organization/user-api-keys/{id}/rotate", "post", 201],
    ["/api/v1/organization/user-api-keys/{id}/revoke", "post", 201],
  ]) assert(operation(route, method, "OrganizationApiKey").responses[status]);
  const create = schema("CreateBusinessUserRequestDto");
  exactProperties(create, ["displayName", "externalId"], []);
  assert.equal(create.additionalProperties, false);
  for (const field of Object.values(properties(create))) {
    assert.equal(field.type, "string");
    assert.equal(field.minLength, 1);
    assert.equal(field.maxLength, 255);
  }
  const organization = properties(schema("CustomerOrganizationResponseDto")).organization;
  exactProperties(organization, ["organizationId", "slug", "name", "createdAt", "updatedAt"]);
  assert.equal(properties(organization).name.nullable, true);
  const user = properties(schema("CustomerBusinessUserResponseDto")).user;
  exactProperties(user, ["userId", "organizationId", "displayName", "externalId", "status", "createdAt", "updatedAt"]);
  assert.equal(user.additionalProperties, false);
  assert.deepEqual(properties(user).status.enum, ["active", "disabled"]);
  assert.equal(properties(user).displayName.nullable, true);
  assert.equal(properties(user).externalId.nullable, true);
  assert.deepEqual(properties(schema("CustomerBusinessUsersResponseDto")).users.items, user);
});

test("published summaries, associations and private Memory operations have only supported fields", () => {
  const directory = responseSchema("/api/v1/agent-templates", "get", 200);
  exactProperties(directory, ["templates", "hasMore", "nextCursor"]);
  assert.equal(resolve(directory).additionalProperties, false);
  const page = properties(directory);
  assert.equal(page.hasMore.type, "boolean");
  assert.equal(page.nextCursor.nullable, true);
  exactProperties(page.templates.items, ["agentTemplateId", "displayName", "description", "latestPublishedVersion"]);
  assert.equal(page.templates.items.additionalProperties, false);
  assert.equal(properties(page.templates.items).latestPublishedVersion.type, "integer");
  assert.equal(properties(page.templates.items).latestPublishedVersion.exclusiveMinimum, true);
  noStore("/api/v1/agent-templates", "get");
  const request = requestSchema("/api/v1/agents", "post");
  exactProperties(request, ["agentTemplateId"]);
  assert.equal(resolve(request).additionalProperties, false);
  assert.equal(properties(request).agentTemplateId.minLength, 1);
  assert.equal(properties(request).agentTemplateId.maxLength, 64);
  const association = responseSchema("/api/v1/agents", "post", 201);
  exactProperties(association, ["agent"]);
  const agent = properties(association).agent;
  exactProperties(agent, ["agentId", "organizationId", "ownerUserId", "agentTemplateId", "status", "createdAt", "updatedAt"]);
  assert.equal(agent.additionalProperties, false);
  assert.deepEqual(properties(agent).status.enum, ["active", "archived"]);
  for (const method of ["get", "delete"]) {
    assert.deepEqual(responseSchema("/api/v1/agents/{id}", method, 200), association);
  }
  const agents = responseSchema("/api/v1/agents", "get", 200);
  exactProperties(agents, ["agents"]);
  assert.deepEqual(properties(agents).agents.items, agent);
  const memory = "/api/v1/agents/{id}/memory/mem9/key";
  const validation = "/api/v1/agents/memory/mem9/key-validations";
  for (const [route, method] of [[memory, "put"], [validation, "post"]]) {
    const input = requestSchema(route, method);
    exactProperties(input, ["mem9Key"]);
    assert.equal(resolve(input).additionalProperties, false);
    assert.equal(properties(input).mem9Key.writeOnly, true);
    noStore(route, method);
  }
  assert.deepEqual(responseSchema(memory, "put", 200), association);
  exactProperties(responseSchema(memory, "get", 200), ["mem9Key"]);
  noStore(memory, "get");
  assert.deepEqual(properties(responseSchema(validation, "post", 200)).valid.enum, [true]);
});

test("Session metadata retains fixed execution provenance and recoverable creation identity", () => {
  const create = requestSchema("/api/v1/sessions", "post");
  exactProperties(create, ["agentId", "billingTag"], ["agentId"]);
  const key = operation("/api/v1/sessions", "post").parameters.find((value) => value.name === "Idempotency-Key");
  assert.equal(key.in, "header");
  assert.equal(key.required, true);
  assert.equal(key.schema.pattern, stableIdentityPattern);
  assert.equal(key.schema.maxLength, 128);
  const envelope = responseSchema("/api/v1/sessions", "post", 201);
  exactProperties(envelope, ["session"]);
  const session = properties(envelope).session;
  exactProperties(session, ["organizationId", "sessionId", "name", "autoTitle", "ownerUserId", "startedByUserId", "createdByType", "readOnly", "sourceSchedulerId", "sourceSchedulerFireId", "sourceVoiceSessionId", "model", "modelRevision", "createdWithAgentId", "template", "modelPolicyStatus", "status", "billingTag", "activeTurnId", "createdAt", "updatedAt", "deletedAt"]);
  const fields = properties(session);
  assert(fields.model.enum.includes("gpt-5.4"));
  assert.equal(fields.modelRevision.type, "integer");
  assert.equal(fields.modelRevision.exclusiveMinimum, true);
  assert.equal(fields.template.nullable, true);
  exactProperties(fields.template, ["templateId", "version", "contentDigest"]);
  assert.equal(properties(fields.template).version.type, "integer");
  assert.equal(properties(fields.template).version.exclusiveMinimum, true);
  assert.deepEqual(fields.modelPolicyStatus.enum, ["allowed", "organization_disallowed"]);
  for (const [route, method, status] of [
    ["/api/v1/sessions/{id}", "get", 200],
    ["/api/v1/sessions/{id}", "delete", 200],
    ["/api/v1/sessions/{id}/billing-tag", "patch", 200],
    ["/api/v1/sessions/{id}/name", "post", 201],
  ]) assert.deepEqual(responseSchema(route, method, status), envelope);
  assert(properties(responseSchema("/api/v1/sessions", "get", 200)).sessions);
  for (const [route, method, status] of [["/api/v1/sessions", "post", 201], ["/api/v1/sessions/{id}", "get", 200]]) {
    assert.match(operation(route, method).responses[status].headers.ETag.description, /model is fixed at creation/);
  }
});

test("ordinary input separates the owning NDJSON response from JSON acceptance and replay receipts", () => {
  const route = "/api/v1/sessions/{id}/turns";
  const create = requestSchema(route, "post");
  exactProperties(create, ["inputId", "input", "clarificationSourceTurnId", "billingTag"], ["inputId", "input"]);
  assert.equal(properties(create).inputId.pattern, stableIdentityPattern);
  const input = properties(create).input;
  exactProperties(input, ["type", "text", "userFileIds"], ["type", "text"]);
  assert.deepEqual(properties(input).type.enum, ["text"]);
  const text = properties(input).text.oneOf;
  assert.equal(text[0].type, "string");
  assert.equal(text[0].minLength, 1);
  assert.equal(text[1].type, "array");
  assert.equal(text[1].minItems, 1);
  assert.equal(text[1].maxItems, 9);
  assert.equal(properties(input).userFileIds.maxItems, 20);
  const stream = responseSchema(route, "post", 201, "application/x-ndjson");
  assert.deepEqual(stream["x-ndjson-event-schema"], { $ref: "#/components/schemas/TurnStreamEvent" });
  for (const status of [200, 202]) {
    assert.deepEqual(responseSchema(route, "post", status), { $ref: "#/components/schemas/SessionInteractionResponseOpenApiDto" });
  }
  assert.match(operation(route, "post").responses[200].description, /original execution outcome without executing again/);
  assert.match(operation(route, "post").responses[202].description, /auxiliary response does not interrupt/);
  assert.match(operation(route, "post").responses[201].description, /closes the response connection.*interruption/);
  const stop = "/api/v1/sessions/{id}/turns/{turnId}/stop";
  const cancellation = requestSchema(stop, "post");
  exactProperties(cancellation, ["inputId"]);
  assert.equal(properties(cancellation).inputId.pattern, stableIdentityPattern);
  for (const status of [200, 202]) {
    assert.deepEqual(responseSchema(stop, "post", status), { $ref: "#/components/schemas/SessionInteractionResponseOpenApiDto" });
  }
  const started = schema("TurnStreamEvent").oneOf.find((variant) => properties(variant).event?.enum?.[0] === "turn_started");
  const payload = properties(properties(started).payload);
  assert.equal(payload.inputId.type, "string");
  assert.match(payload.inputId.description, /required on ordinary JSON text starts/);
  assert.match(payload.inputId.description, /audio\/internal starts may omit/);
  exactProperties(payload.execution, ["model"]);
});

test("saved interactions expose the original generation outcome and ordered Turn history", () => {
  const listRoute = "/api/v1/sessions/{id}/interactions";
  const page = responseSchema(listRoute, "get", 200);
  exactProperties(page, ["interactions", "hasMore", "nextCursor"]);
  const detail = responseSchema(`${listRoute}/{inputId}`, "get", 200);
  exactProperties(detail, ["interaction"]);
  const interaction = properties(detail).interaction;
  exactProperties(interaction, ["inputId", "sequence", "kind", "mode", "turnId", "message", "createdAt", "appliedAt", "rejection", "result"]);
  assert.deepEqual(properties(page).interactions.items, interaction);
  assert.equal(properties(page).nextCursor.nullable, true);
  const fields = properties(interaction);
  assert.deepEqual(fields.kind.enum, ["message", "cancel"]);
  assert.deepEqual(fields.mode.enum, ["started", "steered", "cancelled", "rejected"]);
  assert.equal(fields.sequence.type, "integer");
  assert.equal(fields.sequence.exclusiveMinimum, true);
  exactProperties(fields.message, ["id", "role", "content", "createdAt"]);
  assert.deepEqual(properties(fields.message).role.enum, ["user"]);
  assert.equal(fields.message.nullable, true);
  assert.equal(fields.appliedAt.nullable, true);
  assert.equal(fields.rejection.nullable, true);
  exactProperties(fields.rejection, ["code"]);
  assert.deepEqual(properties(fields.rejection).code.enum, ["interaction_admission_closed", "interaction_target_conflict"]);
  exactProperties(fields.result, ["status", "completedAt"]);
  assert.deepEqual(properties(fields.result).status.enum, ["running", "succeeded", "failed", "interrupted"]);
  assert.equal(properties(fields.result).completedAt.nullable, true);
  assert.match(fields.result.description, /Original execution-generation.*Immutable.*checkpoint retry/);
  const limit = operation(listRoute, "get").parameters.find((value) => value.name === "limit");
  assert.deepEqual(limit.schema, { type: "integer", minimum: 1, maximum: 200, default: 50 });
  const cursor = operation(listRoute, "get").parameters.find((value) => value.name === "cursor");
  assert.match(cursor.description, /Session-bound/);
  assert(operation(`${listRoute}/{inputId}`, "get").responses[404]);
  const turn = schema("Turn");
  assert(turn.required.includes("userMessages"), "public Turn requires ordered userMessages");
  assert.equal(turn.properties.userMessages.type, "array");
  assert.deepEqual(turn.properties.userMessages.items, { $ref: "#/components/schemas/Message" });
  assert(turn.required.includes("billingTag"));
  assert.equal(turn.properties.billingTag.nullable, true);
  assert.deepEqual(turn.properties.billingTag.allOf, [{ $ref: "#/components/schemas/BillingTag" }]);
  assert.deepEqual(properties(responseSchema("/api/v1/sessions/{id}/turns", "get", 200)).turns.items, { $ref: "#/components/schemas/Turn" });
  assert.deepEqual(properties(responseSchema("/api/v1/sessions/{id}/turns/{turnId}", "get", 200)).turn, { $ref: "#/components/schemas/Turn" });
  for (const variant of schema("ClarificationItem").oneOf) {
    exactProperties(properties(variant).response, ["answers", "responseTurnId"]);
  }
  const errors = properties(properties(schema("ErrorEnvelope")).error).code.enum;
  for (const code of ["idempotency_key_required", "invalid_idempotency_key", "session_creation_conflict", "interaction_input_conflict", "interaction_not_found", "interaction_admission_closed", "interaction_target_conflict", "clarification_source_conflict", "auth_kind_forbidden"]) {
    assert(errors.includes(code), `missing stable error ${code}`);
  }
});

test("the customer contract omits unsupported behavior and private execution surfaces", () => {
  const paths = Object.keys(document.paths);
  for (const fragment of ["/auths", "codex", "scheduler-webhook", "/api/admin/", "/config", "/template-versions", "/template-applications", "/template-application-previews", "/model", "/default-agent"]) {
    assert(!paths.some((route) => route.includes(fragment)), `removed route contains ${fragment}`);
  }
  for (const name of ["AssociateTemplateDto", "AssociationResponseDto", "PublishedTemplateSummariesDto", "CreateSessionOpenApiDto", "SessionResponseOpenApiDto", "CreateTurnOpenApiDto", "SessionInteractionResponseOpenApiDto"]) {
    const actual = propertyNames(schema(name));
    for (const field of ["agentDefinitionId", "authId", "e2bTemplate", "modelReasoningEffort", "outputSchema", "projectId", "runtime", "workspaceId", "config", "instructions", "hardware", "templateVersion", "overrides", "executionConfiguration", "mem9Key", "memoryCredential", "token", "apiKey", "authorization"]) {
      assert(!actual.has(field), `${name} exposes ${field}`);
    }
  }
});
