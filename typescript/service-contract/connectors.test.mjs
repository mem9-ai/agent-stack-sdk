import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("connectors.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const metadata = JSON.parse(
  await readFile(new URL("metadata.json", import.meta.url)),
);
const connectors = "/api/v1/org/connectors";
const body = (operation) =>
  operation.requestBody.content["application/json"].schema;
const success = (operation, status) =>
  operation.responses[status].content["application/json"].schema;

test("Connector management keeps the selected contract under Organization authority", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.snapshots["connectors.json"],
  );
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(contract.sourceOpenApiSha256, manifest.tidbLinkOpenApiSha256);
  for (const [path, methods] of Object.entries(contract.paths))
    for (const operation of Object.values(methods))
      assert.deepEqual(
        operation.security,
        path === "/api/v1/connectors/jwks" ? undefined : [{ OrganizationApiKey: [] }],
      );
  const register = contract.paths[connectors].post;
  assert.deepEqual(body(register).required, ["displayName"]);
  assert.deepEqual(body(register).properties.transport.enum, [
    "streamable_http",
    "tunnel",
  ]);
  const registration = success(register, "201");
  for (const field of ["connectorId", "status", "connectorVersion", "transport", "endpointUrl"])
    assert(registration.required.includes(field), field);
  assert.deepEqual(registration.properties.status.enum, ["inactive", "active"]);
  assert(body(contract.paths[`${connectors}/{connectorId}`].patch).required.includes("expectedConnectorVersion"));
  for (const action of ["activate", "deactivate"]) {
    const operation = contract.paths[`${connectors}/{connectorId}/${action}`].post;
    assert.deepEqual(body(operation).required, ["expectedConnectorVersion"]);
    assert(operation.responses["201"]);
    assert(operation.responses["409"]);
  }
});

test("callback verification keys and token claims keep their documented form", () => {
  const jwks = contract.paths["/api/v1/connectors/jwks"].get;
  const key = success(jwks, "200").properties.keys.items;
  assert.deepEqual(key.properties.kty.enum, ["OKP"]);
  assert.deepEqual(key.properties.crv.enum, ["Ed25519"]);
  assert.deepEqual(key.properties.alg.enum, ["EdDSA"]);
  for (const text of [
    "iss tidb-link/connector-callback/v1",
    "aud tidb-link/connector",
    "organizationId and connectorId",
    "exp - iat <= 60 seconds",
  ])
    assert(jwks.description.includes(text), text);
});
