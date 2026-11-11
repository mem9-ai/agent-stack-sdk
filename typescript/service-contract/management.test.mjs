import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("management.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const metadata = JSON.parse(
  await readFile(new URL("metadata.json", import.meta.url)),
);
const templates = "/api/v1/org/agent-templates";
const uploads = "/api/v1/org/skills/uploads";
const schema = (name) => contract.components.schemas[name];
const header = (operation, name) =>
  operation.parameters?.find(
    (parameter) => parameter.in === "header" && parameter.name === name,
  );

test("management keeps the selected service contract under Organization authority", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.snapshots["management.json"],
  );
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(contract.sourceOpenApiSha256, manifest.tidbLinkOpenApiSha256);
  for (const methods of Object.values(contract.paths))
    for (const operation of Object.values(methods))
      assert.deepEqual(operation.security, [{ OrganizationApiKey: [] }]);
});

test("Template mutations require idempotency keys and ETags", () => {
  assert(header(contract.paths[templates].post, "Idempotency-Key").required);
  for (const operation of [
    contract.paths[`${templates}/{templateId}`].put,
    contract.paths[`${templates}/{templateId}/archive`].post,
  ]) {
    assert(header(operation, "Idempotency-Key").required);
    assert(header(operation, "If-Match").required);
    assert(operation.responses["409"]);
  }
  const result = schema("OrganizationTemplateResultDto");
  assert.deepEqual(result.required, ["template", "content"]);
  const summary = result.properties.template;
  for (const field of [
    "id",
    "displayName",
    "lifecycleStatus",
    "etag",
    "contentDigest",
  ])
    assert(summary.required.includes(field), field);
  assert.deepEqual(summary.properties.lifecycleStatus.enum, [
    "active",
    "archived",
  ]);
  const content = schema("OrganizationTemplateCreateDto").properties.content;
  for (const field of ["identity", "sandbox", "realtime"])
    assert(content.required.includes(field), field);
  assert.deepEqual(content.properties.realtime.properties.language.enum, [
    "zh-CN",
    "en-US",
  ]);
  const page = schema("OrganizationTemplateListDto");
  assert.deepEqual(Object.keys(page.properties).sort(), [
    "data",
    "hasMore",
    "nextCursor",
    "readAt",
  ]);
  const names = contract.paths[templates].get.parameters.map((p) => p.name);
  for (const name of ["sort", "lifecycleStatus", "q", "cursor", "limit"])
    assert(names.includes(name), name);
});

test("Skill uploads take raw ZIP bytes and publish asynchronously", () => {
  const create = contract.paths[uploads].post;
  assert(header(create, "Idempotency-Key").required);
  assert(create.requestBody.content["application/octet-stream"]);
  const state =
    create.responses["202"].content["application/json"].schema.properties
      .upload.properties.state;
  for (const value of ["awaiting_confirmation", "done", "failed", "aborted"])
    assert(state.enum.includes(value), value);
  const publish = contract.paths[`${uploads}/{uploadId}/publish`].post;
  assert(header(publish, "Idempotency-Key").required);
  assert(publish.responses["202"]);
  assert(publish.responses["410"]);
  assert(contract.paths[`${uploads}/{uploadId}`].delete.responses["204"]);
  assert.deepEqual(
    Object.keys(schema("OrganizationSkillListDto").properties).sort(),
    ["nextCursor", "skills"],
  );
  assert.deepEqual(
    Object.keys(schema("OrganizationSkillDetailDto").properties).sort(),
    ["nextCursor", "skill", "versions"],
  );
});
