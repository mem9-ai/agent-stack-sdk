import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const expectedServiceRevision = "7c12ed1a4f75ebb808b642f07f8fcd25259cf0f6";

const contractRoot = process.env.TIDB_LINK_CONTRACT;
if (!contractRoot) throw new Error("TIDB_LINK_CONTRACT is required");

const openApiBytes = await readFile(path.join(contractRoot, "openapi.json"));
const document = JSON.parse(openApiBytes);
const metadata = JSON.parse(
  await readFile(path.join(contractRoot, "metadata.json"), "utf8"),
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const schema = (name) => {
  const value = document.components?.schemas?.[name];
  assert(value, `missing schema ${name}`);
  return value;
};

const properties = (value) => {
  if (value.$ref) return properties(schema(value.$ref.split("/").at(-1)));
  return value.properties ?? {};
};

const propertyNames = (value, names = new Set()) => {
  if (!value || typeof value !== "object") return names;
  if (value.properties) {
    for (const [name, nested] of Object.entries(value.properties)) {
      names.add(name);
      propertyNames(nested, names);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    for (const nested of value[key] ?? []) propertyNames(nested, names);
  }
  if (value.items) propertyNames(value.items, names);
  if (value.$ref) propertyNames(schema(value.$ref.split("/").at(-1)), names);
  return names;
};

test("the SDK declaration maps to one immutable TiDB Link contract", () => {
  assert.equal(metadata.tidbLinkRevision, expectedServiceRevision);
  assert.equal(metadata.tidbLinkApiVersion, "0.0.1");
  assert.equal(packageJson.tidbLinkRevision, metadata.tidbLinkRevision);
  assert.equal(
    packageJson.tidbLinkApiVersion,
    metadata.tidbLinkApiVersion,
  );
  assert.equal(
    createHash("sha256").update(openApiBytes).digest("hex"),
    metadata.sha256,
  );
});

test("the declared contract exposes the supported Organization and User workflows", () => {
  for (const route of [
    "/api/admin/org/users/{userId}/api-keys",
    "/api/admin/org/user-api-keys/{id}/rotate",
    "/api/admin/org/user-api-keys/{id}/revoke",
    "/api/agents",
    "/api/agents/{id}/config",
    "/api/agents/{id}/memory/mem9/key",
    "/api/agents/memory/mem9/key-validations",
    "/api/sessions",
    "/api/sessions/{id}/model",
    "/api/sessions/{id}/turns",
    "/api/sessions/{id}/turns/{turnId}",
  ]) {
    assert(document.paths[route], `missing ${route}`);
  }

  assert.equal(document.info.title, "TiDB Link API");
  const securitySchemes = document.components.securitySchemes;
  assert.equal(securitySchemes.TiDBLinkSession.type, "apiKey");
  assert.equal(securitySchemes.TiDBLinkSession.in, "cookie");
  assert.equal(securitySchemes.Agent9Session, undefined);
  for (const name of ["OrganizationApiKey", "UserApiKey"]) {
    assert.equal(securitySchemes[name].type, "http");
    assert.equal(securitySchemes[name].scheme, "bearer");
    assert.notEqual(securitySchemes[name].bearerFormat, "JWT");
  }
  const organizationIntent =
    document.paths["/api/admin/org/users/{userId}/api-keys"].post.parameters
      .filter((parameter) => parameter.in === "header");
  assert(organizationIntent.some((parameter) => parameter.name === "x-ti-target-organization-id"));
  assert(!organizationIntent.some((parameter) => parameter.name === "x-agent9-target-organization-id"));

  const organizationSecurity =
    document.paths["/api/admin/org/users/{userId}/api-keys"].get.security;
  assert(organizationSecurity.some((item) => "OrganizationApiKey" in item));
  const userSecurity = document.paths["/api/agents"].post.security;
  assert(userSecurity.some((item) => "UserApiKey" in item));
});

test("the declared request and response schemas contain only retained SDK capabilities", () => {
  const retained = [
    "CreateAgentOpenApiDto",
    "PatchAgentConfigOpenApiDto",
    "AgentResponseOpenApiDto",
    "CreateSessionOpenApiDto",
    "SessionResponseOpenApiDto",
    "CreateTurnOpenApiDto",
    "TurnStreamEvent",
  ];
  const removed = [
    "agentDefinitionId",
    "authId",
    "e2bTemplate",
    "modelReasoningEffort",
    "outputSchema",
    "projectId",
    "runtime",
    "workspaceId",
  ];
  for (const name of retained) {
    const actual = propertyNames(schema(name));
    for (const field of removed)
      assert(!actual.has(field), `${name} exposes ${field}`);
  }

  const createAgent = properties(schema("CreateAgentOpenApiDto"));
  assert(createAgent.memoryCredential);
  assert.equal(createAgent.agentTemplateId.minLength, 1);
  assert.match(createAgent.agentTemplateId.description, /Required for a new Agent/);
  assert(createAgent.templateVersion && createAgent.overrides);
  assert(properties(createAgent.config).hardware);
  const patch = properties(schema("PatchAgentConfigOpenApiDto"));
  assert(patch.hardware && patch.instructions);
  const agent = properties(properties(schema("AgentResponseOpenApiDto")).agent);
  assert(
    agent.instructions && agent.creationOrigin && agent.templateApplication,
  );
  for (const route of [
    "/api/agents/template-versions/{templateId}/{version}",
    "/api/agents/{agentId}/template-application-previews",
    "/api/agents/{agentId}/template-applications",
  ])
    assert(document.paths[route], `missing ${route}`);
  assert.deepEqual(
    Object.keys(properties(properties(createAgent.config).memory)),
    ["enabled"],
  );
  const agentConfig = properties(
    properties(schema("AgentResponseOpenApiDto")).agent,
  ).config;
  assert(properties(properties(agentConfig).memory).provider);
  assert(properties(properties(properties(agentConfig).memory).mem9).hasKey);

  const createSession = properties(schema("CreateSessionOpenApiDto"));
  assert(createSession.agentId);
  const session = properties(
    properties(schema("SessionResponseOpenApiDto")).session,
  );
  assert(
    session.organizationId &&
      session.ownerUserId &&
      session.createdWithAgentId &&
      session.model,
  );
  assert(
    !properties(schema("UpdateSessionModelOpenApiDto")).model.enum.includes(
      "gpt-5.4",
    ),
  );
  assert(session.model.enum.includes("gpt-5.4"));

  const createTurn = properties(schema("CreateTurnOpenApiDto"));
  assert(createTurn.clarificationSourceTurnId);
  const turn = schema("Turn");
  assert(turn.required.includes("billingTag"));
  assert.equal(turn.properties.billingTag.nullable, true);
  assert.deepEqual(turn.properties.billingTag.allOf, [
    { $ref: "#/components/schemas/BillingTag" },
  ]);
  const clarification = schema("ClarificationItem");
  for (const variant of clarification.oneOf) {
    const response = properties(variant).response;
    assert(response);
    assert.deepEqual(Object.keys(properties(response)).sort(), [
      "answers",
      "responseTurnId",
    ]);
  }

  const started = schema("TurnStreamEvent").oneOf.find(
    (variant) => properties(variant).event?.enum?.[0] === "turn_started",
  );
  const execution = properties(properties(started).payload).execution;
  assert.deepEqual(Object.keys(properties(execution)), ["model"]);
});

test("the declared contract has no dedicated route for removed product areas", () => {
  const paths = Object.keys(document.paths);
  for (const fragment of ["/auths", "codex", "scheduler-webhook"]) {
    assert(
      !paths.some((route) => route.includes(fragment)),
      `removed route contains ${fragment}`,
    );
  }
});
