import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const bytes = await readFile(new URL("files.json", import.meta.url));
const contract = JSON.parse(bytes);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url)),
);
const metadata = JSON.parse(
  await readFile(new URL("metadata.json", import.meta.url)),
);
const upload = "/api/v1/org/users/{userId}/drive/uploads";

test("file transfers retain the exact selected service contract and separate User and ticket authority", () => {
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.snapshots["files.json"],
  );
  assert.equal(metadata.tidbLinkRevision, manifest.tidbLinkRevision);
  assert.equal(contract.revision, manifest.tidbLinkRevision);
  assert.equal(
    contract.sourceOpenApiSha256,
    manifest.tidbLinkOpenApiSha256,
  );
  for (const [path, methods] of Object.entries(contract.paths)) {
    for (const operation of Object.values(methods)) {
      assert.deepEqual(
        operation.security,
        path.includes("{ticket}") ? [] : path.includes("/org/users/") ? [{ OrganizationApiKey: [] }] : [{ UserApiKey: [] }],
      );
    }
  }
  assert(
    contract.paths[upload].post.parameters.some(
      (header) => header.name === "Idempotency-Key" && header.required,
    ),
  );
  for (const header of ["Content-Length", "Content-Digest"])
    assert(
      contract.paths[`${upload}/{uploadId}/content`].put.parameters.some(
        (value) => value.name === header && value.required,
      ),
    );
  assert.equal(
    contract.paths[`${upload}/{uploadId}/content`].put.requestBody.content[
      "application/octet-stream"
    ].schema.format,
    "binary",
  );
  assert.deepEqual(
    contract.components.schemas.FileUploadResponseDto.properties.upload
      .properties.expectedChecksumVerification.enum,
    ["whole"],
  );
  const part =
    contract.components.schemas.PublicUserFileUploadPartResponseOpenApiDto
      .properties.part;
  assert.deepEqual(part.required, [
    "number",
    "url",
    "size",
    "headers",
    "expiresAt",
  ]);
  assert.deepEqual(
    contract.components.schemas.FileConfirmationDto.properties.parts.items
      .required,
    ["number", "etag", "sha256"],
  );
  const content =
    contract.paths["/api/v1/org/users/{userId}/files/{fileId}/content"].get.responses["200"]
      .content;
  assert.equal(content["*/*"].schema.format, "binary");
  assert.deepEqual(
    content["application/vnd.tidb-link.file-download+json"].schema.required,
    ["url", "expiresAt", "byteSize", "sha256"],
  );
  assert(
    contract.paths["/api/v1/drive-downloads/{ticket}"].get.responses["302"],
  );
  assert.deepEqual(contract.components.schemas.FilesPageDto.required, [
    "files",
    "nextCursor",
  ]);
});
