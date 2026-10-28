import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { UserClient, TiDBLinkApiError } from "../dist/index.js";

const apiKey = "ti_user_file_" + "x".repeat(43);
const servers = [];
after(async () =>
  Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  ),
);
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

test("file content uses the owned binary endpoint and preserves service refusal", async () => {
  const baseUrl = await serve((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    if (request.url === "/api/v1/files/owned/content") {
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end("owned bytes");
    } else {
      response
        .writeHead(404, {
          "content-type": "application/json",
          "x-request-id": "file-refusal",
        })
        .end(
          JSON.stringify({
            error: { code: "drive_file_not_found", message: "Not found" },
          }),
        );
    }
  });
  const user = new UserClient({ baseUrl, apiKey });
  const content = await user.files.getContent("owned");
  assert.equal(content.type, "bytes");
  assert.equal(new TextDecoder().decode(content.bytes), "owned bytes");
  assert.equal(content.contentType, "text/plain");
  await assert.rejects(
    user.files.getContent("foreign"),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.status === 404 &&
      error.requestId === "file-refusal",
  );
});

const ready = (fileId, bytes = "abc") => ({
  fileId,
  originalName: "note.txt",
  status: "ready",
  byteSize: Buffer.byteLength(bytes),
  sha256:
    bytes === ""
      ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      : "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  checksumVerification: "whole",
  contentType: "text/plain",
  lastError: null,
  source: { kind: "user_upload" },
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
});
const json = (res, value, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
const readBytes = async (request) =>
  Buffer.concat(await Array.fromAsync(request));

test("inline upload sends exact bytes with a complete digest, confirms ready and recovers the same identity", async () => {
  const requests = [];
  const file = ready("file-inline");
  const baseUrl = await serve(async (request, response) => {
    const bytes = await readBytes(request);
    requests.push({ path: request.url, headers: request.headers, bytes });
    if (request.url.endsWith("/uploads")) {
      assert.deepEqual(JSON.parse(bytes), {
        originalName: "note.txt",
        byteSize: 3,
        sha256: file.sha256,
        contentType: "text/plain",
      });
      assert.equal(request.headers["idempotency-key"], "stable-file");
      json(
        response,
        {
          upload: {
            uploadId: file.fileId,
            mode: "tidb-link",
            expiresAt: "2099-01-01T00:00:00.000Z",
            expectedChecksumVerification: "whole",
            file: { ...file, status: "uploading" },
          },
        },
        201,
      );
    } else if (request.url.endsWith("/content")) {
      assert.equal(bytes.toString(), "abc");
      assert.equal(request.headers["content-length"], "3");
      assert.equal(
        request.headers["content-digest"],
        "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:",
      );
      json(response, { file });
    } else if (request.url.endsWith("/complete")) {
      assert.deepEqual(JSON.parse(bytes), {});
      json(response, { file });
    } else {
      json(response, {
        upload: {
          uploadId: file.fileId,
          mode: "tidb-link",
          state: "completed",
          expiresAt: "2099-01-01T00:00:00.000Z",
          file,
        },
      });
    }
  });
  const user = new UserClient({ baseUrl, apiKey });
  assert.deepEqual(
    await user.files.upload({
      originalName: "note.txt",
      bytes: new TextEncoder().encode("abc"),
      contentType: "text/plain",
      idempotencyKey: "stable-file",
    }),
    file,
  );
  assert.equal((await user.files.getUpload(file.fileId)).state, "completed");
  assert.equal(requests.filter((r) => r.path.endsWith("/uploads")).length, 1);
});

test("multipart upload follows the service plan, binds each checksum and never sends the API Key to storage", async () => {
  const whole = new TextEncoder().encode("abc");
  const stored = [];
  const storage = await serve(async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-request-id"], undefined);
    assert(req.headers["x-amz-checksum-sha256"]);
    stored.push(await readBytes(req));
    res.writeHead(200, { etag: `"part-${stored.length}"` }).end();
  });
  const parts = [];
  const baseUrl = await serve(async (req, res) => {
    const body = JSON.parse((await readBytes(req)).toString() || "{}");
    if (req.url.endsWith("/uploads")) {
      json(res, {
        upload: {
          uploadId: "multipart",
          mode: "s3",
          partSize: 2,
          totalParts: 2,
          expectedChecksumVerification: "whole",
          expiresAt: "2099-01-01T00:00:00.000Z",
          file: { ...ready("multipart"), status: "uploading" },
        },
      });
    } else if (req.url.endsWith("/presign")) {
      const number = Number(req.url.split("/").at(-2));
      parts.push({ number, sha256: body.sha256 });
      json(res, {
        part: {
          number,
          size: number === 1 ? 2 : 1,
          url: storage + "/part",
          headers: {
            "x-amz-checksum-sha256": Buffer.from(body.sha256, "hex").toString(
              "base64",
            ),
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    } else {
      assert.deepEqual(
        body.parts,
        parts.map((p) => ({ ...p, etag: `"part-${p.number}"` })),
      );
      json(res, { file: ready("multipart") });
    }
  });
  const user = new UserClient({ baseUrl, apiKey });
  assert.equal(
    (
      await user.files.upload({
        originalName: "note.txt",
        bytes: whole,
        idempotencyKey: "multipart-key",
      })
    ).status,
    "ready",
  );
  assert.equal(Buffer.concat(stored).toString(), "abc");
  assert.equal(
    parts[0].sha256,
    "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603",
  );
  assert.equal(
    parts[1].sha256,
    "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6",
  );
});

test("empty inline uploads use the supplied short-lived URL without an API Key", async () => {
  const bytes = new Uint8Array();
  const file = ready("empty", "");
  const storage = await serve(async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["content-length"], "0");
    assert.equal((await readBytes(req)).length, 0);
    assert.equal(
      req.headers["content-digest"],
      "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:",
    );
    json(res, { file });
  });
  const baseUrl = await serve(async (req, res) => {
    await readBytes(req);
    if (req.url.endsWith("/uploads"))
      json(res, {
        upload: {
          uploadId: file.fileId,
          mode: "tidb-link",
          expiresAt: "2099-01-01T00:00:00.000Z",
          expectedChecksumVerification: "whole",
          file: { ...file, status: "uploading" },
          uploadUrl: {
            method: "PUT",
            url: storage + "/upload?secret=ticket",
            headers: {
              "content-type": "application/octet-stream",
              "content-digest":
                "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:",
            },
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      });
    else json(res, { file });
  });
  assert.deepEqual(
    await new UserClient({ baseUrl, apiKey }).files.upload({
      originalName: "empty",
      bytes,
      idempotencyKey: "empty-key",
    }),
    file,
  );
});

test("file listing preserves its own cursor/history semantics and verified downloads use ticket authority only", async () => {
  const file = ready("download");
  const storage = await serve((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res
      .writeHead(200, { "content-type": "text/plain", "content-length": "3" })
      .end("abc");
  });
  const grant = {
    url: storage + "/download?ticket=secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    byteSize: 3,
    sha256: file.sha256,
  };
  const baseUrl = await serve((req, res) => {
    if (req.url.startsWith("/api/v1/files?")) {
      const query = new URL(req.url, "http://example").searchParams;
      assert.equal(query.get("history"), "true");
      assert.equal(query.get("limit"), "1");
      assert.equal(query.get("cursor"), "cursor/+");
      json(res, { files: [file], nextCursor: "next" });
    } else if (req.url.endsWith("/content"))
      res
        .writeHead(200, {
          "content-type": "application/vnd.tidb-link.file-download+json",
        })
        .end(JSON.stringify(grant));
    else json(res, { file });
  });
  const user = new UserClient({ baseUrl, apiKey });
  assert.deepEqual(
    await user.files.list({ history: true, limit: 1, cursor: "cursor/+" }),
    { files: [file], nextCursor: "next" },
  );
  assert.deepEqual(await user.files.getContent("download"), {
    type: "download",
    grant,
  });
  assert.equal(
    new TextDecoder().decode(await user.files.download("download")),
    "abc",
  );
});

test("uncertain file creation retains its key and never repeats the effect", async () => {
  let attempts = 0;
  const baseUrl = await serve((req, res) => {
    attempts++;
    req.socket.destroy();
  });
  const user = new UserClient({ baseUrl, apiKey });
  await assert.rejects(
    user.files.upload({
      originalName: "x",
      bytes: new Uint8Array(),
      idempotencyKey: "recover-original",
    }),
    (error) =>
      error.name === "FileUploadOutcomeUnknownError" &&
      error.idempotencyKey === "recover-original" &&
      error.uploadId === undefined,
  );
  assert.equal(attempts, 1);
});

test("uncertain multipart transfers retain upload identity and do not complete or replay effects", async () => {
  let attempts = 0;
  let complete = false;
  const storage = await serve(async (req, res) => {
    await readBytes(req);
    attempts++;
    res.writeHead(503).end();
  });
  const baseUrl = await serve(async (req, res) => {
    const body = JSON.parse((await readBytes(req)).toString() || "{}");
    if (req.url.endsWith("/uploads"))
      json(res, {
        upload: {
          uploadId: "uncertain-file",
          mode: "s3",
          partSize: 3,
          totalParts: 1,
          expiresAt: "2099-01-01T00:00:00.000Z",
          expectedChecksumVerification: "whole",
          file: { ...ready("uncertain-file"), status: "uploading" },
        },
      });
    else if (req.url.endsWith("/presign"))
      json(res, {
        part: {
          number: 1,
          size: 3,
          url: storage,
          headers: {
            "x-amz-checksum-sha256": Buffer.from(body.sha256, "hex").toString(
              "base64",
            ),
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    else {
      complete = true;
      json(res, { file: ready("uncertain-file") });
    }
  });
  await assert.rejects(
    new UserClient({ baseUrl, apiKey }).files.upload({
      originalName: "x",
      bytes: Buffer.from("abc"),
      idempotencyKey: "retain-me",
    }),
    (error) =>
      error.name === "FileUploadOutcomeUnknownError" &&
      error.uploadId === "uncertain-file" &&
      error.idempotencyKey === "retain-me",
  );
  assert.equal(attempts, 1);
  assert.equal(complete, false);
});

test("expired and mismatched part grants are refused before any bytes are sent", async () => {
  let transfers = 0;
  const url = await serve((req, res) => {
    transfers++;
    res.end();
  });
  const files = new UserClient({ baseUrl: url, apiKey }).files;
  const part = {
    number: 1,
    size: 3,
    url,
    headers: {
      "x-amz-checksum-sha256": "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    },
    expiresAt: "2000-01-01T00:00:00.000Z",
  };
  await assert.rejects(
    files.uploadPart(part, Buffer.from("abc")),
    (error) => error.code === "file_transfer_expired",
  );
  await assert.rejects(
    files.uploadPart(
      { ...part, expiresAt: "2099-01-01T00:00:00.000Z" },
      Buffer.from("bad"),
    ),
    /checksum/,
  );
  await assert.rejects(files.uploadPart(part, Buffer.from("abcd")), /size/);
  assert.equal(transfers, 0);
});

test("upload and authenticated content redirects never send keys to another destination", async () => {
  let leaked = 0;
  const other = await serve((req, res) => {
    leaked++;
    res.end();
  });
  const baseUrl = await serve((req, res) =>
    res.writeHead(307, { location: other + "/redirected?ticket=hidden" }).end(),
  );
  const files = new UserClient({ baseUrl, apiKey }).files;
  await assert.rejects(files.getContent("file"));
  const part = {
    number: 1,
    size: 3,
    url: baseUrl + "/signed?secret=not-for-errors",
    headers: {
      "x-amz-checksum-sha256": "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  await assert.rejects(
    files.uploadPart(part, Buffer.from("abc")),
    (error) =>
      !String(error).includes("secret=") && !String(error).includes(apiKey),
  );
  assert.equal(leaked, 0);
});

test("download checks complete content and keeps expired grants unusable", async () => {
  let requests = 0;
  const baseUrl = await serve((req, res) => {
    requests++;
    res.end("abd");
  });
  const files = new UserClient({ baseUrl, apiKey }).files;
  const grant = {
    url: baseUrl,
    expiresAt: "2099-01-01T00:00:00.000Z",
    byteSize: 3,
    sha256: ready("a").sha256,
  };
  await assert.rejects(files.downloadFromGrant(grant), /checksum/);
  await assert.rejects(
    files.downloadFromGrant({
      ...grant,
      expiresAt: "2000-01-01T00:00:00.000Z",
    }),
    (error) => error.code === "file_transfer_expired",
  );
  assert.equal(requests, 1);
});
