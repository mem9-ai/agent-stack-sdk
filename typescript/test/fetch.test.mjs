import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient } from "../dist/index.js";

const apiKey = "ti_org_fetch_" + "x".repeat(43);
const baseUrl = "https://tidb-link.test";
const storage = "https://storage.test";
const json = (value, init = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("an injected fetch carries every request, including file transfers", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body =
      init.body === undefined
        ? undefined
        : new Uint8Array(await new Response(init.body).arrayBuffer());
    calls.push({ method: init.method ?? "GET", url: url.href, headers, body });
    if (url.origin === storage) {
      assert.equal(headers.get("authorization"), null);
      if (init.method === "PUT")
        return new Response(null, { headers: { etag: '"part-1"' } });
      return new Response("abc");
    }
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    const path = url.pathname;
    if (path === "/api/v1/org/users") return json({ users: [] });
    if (path.endsWith("/drive/uploads"))
      return json({
        upload: {
          uploadId: "upload_1",
          mode: "s3",
          partSize: 3,
          totalParts: 1,
          expectedChecksumVerification: "whole",
          expiresAt: "2099-01-01T00:00:00.000Z",
          file: { ...file, status: "uploading" },
        },
      });
    if (path.endsWith("/presign"))
      return json({
        part: {
          number: 1,
          size: 3,
          url: `${storage}/part`,
          headers: {
            "x-amz-checksum-sha256": Buffer.from(
              JSON.parse(new TextDecoder().decode(body)).sha256,
              "hex",
            ).toString("base64"),
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    if (path.endsWith("/complete")) return json({ file });
    throw new Error(`Unexpected request ${init.method} ${url}`);
  };
  const bytes = new TextEncoder().encode("abc");
  const file = {
    fileId: "upload_1",
    originalName: "note.txt",
    status: "ready",
    byteSize: 3,
    sha256: sha256(bytes),
    checksumVerification: "whole",
    contentType: "text/plain",
    lastError: null,
    source: { kind: "user_upload" },
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };

  const organization = new OrganizationClient({ baseUrl, apiKey, fetch });
  assert.deepEqual(await organization.listEndUsers(), []);

  const user = organization.user("user_1");
  const uploaded = await user.files.upload({
    originalName: "note.txt",
    bytes,
    idempotencyKey: "upload-key",
  });
  assert.equal(uploaded.status, "ready");

  const downloaded = await user.files.downloadFromGrant({
    url: `${storage}/download`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    byteSize: 3,
    sha256: file.sha256,
  });
  assert.equal(new TextDecoder().decode(downloaded), "abc");

  assert.deepEqual(
    calls.map(({ method, url }) => `${method} ${url}`),
    [
      `GET ${baseUrl}/api/v1/org/users`,
      `POST ${baseUrl}/api/v1/org/users/user_1/drive/uploads`,
      `POST ${baseUrl}/api/v1/org/users/user_1/drive/uploads/upload_1/parts/1/presign`,
      `PUT ${storage}/part`,
      `POST ${baseUrl}/api/v1/org/users/user_1/drive/uploads/upload_1/complete`,
      `GET ${storage}/download`,
    ],
  );
  assert.equal(new TextDecoder().decode(calls[3].body), "abc");
});

test("fetch must be a function", () => {
  assert.throws(
    () => new OrganizationClient({ baseUrl, apiKey, fetch: "fetch" }),
    TypeError,
  );
});
