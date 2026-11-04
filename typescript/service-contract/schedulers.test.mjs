import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("schedulers.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);

test("Schedulers keep their selected public authority, creation identity, conditional writes and fire projection", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "b6fb4c513f508f22b7ac49b488424ca126ad98a153695e7d54d38c23c25628e6",
  );
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(
    contract.sourceOpenApiSha256,
    manifest.tidbLinkOpenApiSha256,
  );
  for (const [path, methods] of Object.entries(contract.paths))
    for (const operation of Object.values(methods))
      assert.deepEqual(operation.security, path.includes("/org/users/") ? [{ OrganizationApiKey: [] }] : [{ UserApiKey: [] }]);
  const create = contract.paths["/api/v1/schedulers"].post;
  assert(
    create.parameters.some(
      (header) => header.name === "Idempotency-Key" && header.required,
    ),
  );
  assert(create.responses["201"].headers.ETag);
  assert(create.responses["409"].headers["Retry-After"]);
  for (const method of ["patch", "delete"]) {
    const operation =
      contract.paths["/api/v1/schedulers/{schedulerId}"][method];
    assert(
      operation.parameters.some(
        (header) => header.name === "If-Match" && header.required,
      ),
    );
    assert(operation.responses["412"]);
    assert(operation.responses["428"]);
  }
  assert(
    contract.paths["/api/v1/schedulers/{schedulerId}"].delete.responses["204"],
  );
  const schemas = contract.components.schemas;
  assert.deepEqual(schemas.PublicSchedulerListResponseOpenApiDto.required, [
    "schedulers",
    "nextCursor",
  ]);
  const firePage = schemas.PublicSchedulerFiresResponseOpenApiDto;
  assert.deepEqual(firePage.required, ["fires", "nextCursor"]);
  const fire = firePage.properties.fires.items.properties;
  assert.deepEqual(fire.executionStatus.enum, [
    "pending",
    "completed",
    "failed",
  ]);
  for (const field of ["sessionId", "turnId", "messageId", "failureCode"])
    assert.equal(fire.result.properties[field].nullable, true);
  assert.equal(
    schemas.CreateBoundSessionPublicSchedulerOpenApiDto.additionalProperties,
    false,
  );
  assert(
    !schemas.CreateBoundSessionPublicSchedulerOpenApiDto.properties.agentId,
  );
});


test("only Organization Scheduler lists include deleted history", () => {
  const own = contract.paths["/api/v1/schedulers"].get;
  const organization = contract.paths["/api/v1/org/users/{userId}/schedulers"].get;
  assert.deepEqual(own.parameters.find((p) => p.name === "status").schema.enum, ["enabled", "disabled"]);
  assert.deepEqual(organization.parameters.find((p) => p.name === "status").schema.enum, ["enabled", "disabled", "deleted"]);
  assert.deepEqual(contract.components.schemas.OrganizationSchedulerListResponseOpenApiDto.properties.schedulers.items.properties.status.enum, ["enabled", "disabled", "deleted"]);
});
