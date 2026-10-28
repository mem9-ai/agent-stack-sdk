import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const expectedServiceRevision = "49f2bb3b7d194ada614cf9caa0a79f24e7aeba87";

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

test("retained Turn APIs keep their historical immutable contract evidence", () => {
  assert.equal(metadata.tidbLinkRevision, expectedServiceRevision);
  assert.equal(metadata.tidbLinkApiVersion, "0.0.1");
  assert.equal(packageJson.tidbLinkRevision, metadata.tidbLinkRevision);
  assert.equal(packageJson.tidbLinkApiVersion, metadata.tidbLinkApiVersion);
  assert.equal(
    createHash("sha256").update(openApiBytes).digest("hex"),
    metadata.sha256,
  );
});

test("the historical contract records retained Turn/history workflows", () => {
  for (const route of [
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
  const userSecurity = document.paths["/api/sessions/{id}/turns"].get.security;
  assert(userSecurity.some((item) => "UserApiKey" in item));
});

test("the declared request and response schemas contain only retained SDK capabilities", () => {
  const retained = ["CreateTurnOpenApiDto", "TurnStreamEvent"];
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
