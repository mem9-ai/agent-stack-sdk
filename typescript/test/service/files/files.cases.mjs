import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { test } from "node:test";
import { UserClient, TiDBLinkApiError } from "@mem9/tidb-link";
import { uploadFileWorkflow } from "@mem9/tidb-link/examples/upload-file.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const local = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const remote = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_FILE_REMOTE_USER_KEY,
});
const stranger = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_USER_KEY,
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadata = (bytes, originalName = "note.txt") => ({
  originalName,
  byteSize: bytes.length,
  sha256: sha(bytes),
  contentType: "text/plain",
  idempotencyKey: randomUUID(),
});
const newSession = async () =>
  (
    await local.createAgent({
      agentTemplateId: process.env.SDK_TEMPLATE_ID,
      idempotencyKey: randomUUID(),
    })
  ).createSession({ idempotencyKey: randomUUID() });

test("actual inline/empty uploads become verified files and selected bytes participate in a real Turn", async () => {
  const secret = `only-in-file-${randomUUID()}`;
  const bytes = Buffer.from(secret);
  const input = {
    originalName: "note.txt",
    bytes,
    contentType: "text/plain",
    idempotencyKey: randomUUID(),
  };
  const file = await local.files.upload(input);
  assert.equal(file.status, "ready");
  assert.equal(file.sha256, sha(bytes));
  assert.equal((await local.files.upload(input)).fileId, file.fileId);
  assert.equal((await local.files.getUpload(file.fileId)).state, "completed");
  assert.deepEqual(Buffer.from(await local.files.download(file.fileId)), bytes);
  const empty = await local.files.upload({
    originalName: "empty.txt",
    bytes: new Uint8Array(),
    idempotencyKey: randomUUID(),
  });
  assert.equal(empty.byteSize, 0);
  assert.equal((await local.files.download(empty.fileId)).byteLength, 0);
  const page = await local.files.list({ limit: 1 });
  assert.equal(page.files.length, 1);
  assert(page.nextCursor);
  assert.equal(
    (await local.files.list({ limit: 1, cursor: page.nextCursor })).files[0]
      .fileId,
    file.fileId,
  );
  const session = await newSession();
  const result = await session.turn(
    {
      clientEventId: randomUUID(),
      text: `Read the attached file /home/user/uploads/${file.fileId}/note.txt and report its content.`,
      userFileIds: [file.fileId],
    },
    { timeoutMs: 20000, pollIntervalMs: 25 },
  );
  assert(result.text.includes(secret), result.text);
  const turn = await session.getTurn(result.turnId);
  assert.equal(turn.userFiles[0].userFileId, file.fileId);
  await assert.rejects(
    stranger.files.get(file.fileId),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  const strangerAgent = await stranger.createAgent({
    agentTemplateId: process.env.SDK_TEMPLATE_ID,
    idempotencyKey: randomUUID(),
  });
  const strangerSession = await strangerAgent.createSession({
    idempotencyKey: randomUUID(),
  });
  await assert.rejects(
    strangerSession.submitMessage({
      clientEventId: randomUUID(),
      text: "Read foreign file",
      userFileIds: [file.fileId],
    }),
    (error) =>
      error instanceof TiDBLinkApiError && [400, 404].includes(error.status),
  );
});

test("actual multipart bytes are presigned, transferred, whole-file verified and downloaded", async () => {
  const capabilities = await remote.files.capabilities();
  assert.equal(capabilities.inlineThreshold, 5);
  const bytes = Buffer.from("multipart exact bytes and checksum");
  const file = await remote.files.upload({
    originalName: "multipart.txt",
    bytes,
    contentType: "text/plain",
    idempotencyKey: randomUUID(),
  });
  assert.equal(file.status, "ready");
  assert.equal(file.byteSize, bytes.length);
  assert.equal(file.sha256, sha(bytes));
  assert.equal(file.checksumVerification, "whole");
  assert.deepEqual(
    Buffer.from(await remote.files.download(file.fileId)),
    bytes,
  );
  assert.equal((await remote.files.getUpload(file.fileId)).mode, "s3");
});

test("actual uploads retain identity and refuse incomplete, cancelled and corrupt content", async () => {
  const bytes = Buffer.from("abc");
  const input = metadata(bytes);
  const upload = await local.files.createUpload(input);
  const replay = await local.files.createUpload(input);
  assert.equal(replay.uploadId, upload.uploadId);
  assert.equal(replay.expiresAt, upload.expiresAt);
  await assert.rejects(
    local.files.createUpload({ ...input, originalName: "changed.txt" }),
    (error) => error instanceof TiDBLinkApiError && error.status === 409,
  );
  await assert.rejects(
    local.files.completeUpload(upload.uploadId),
    (error) =>
      error instanceof TiDBLinkApiError && error.code === "upload_incomplete",
  );
  const session = await newSession();
  await assert.rejects(
    session.submitMessage({
      clientEventId: randomUUID(),
      text: "Read unfinished file",
      userFileIds: [upload.uploadId],
    }),
    (error) => error instanceof TiDBLinkApiError,
  );
  const cancelled = await local.files.cancelUpload(upload.uploadId);
  assert.equal(cancelled.status, "failed");
  assert.equal((await local.files.getUpload(upload.uploadId)).state, "aborted");
  await assert.rejects(
    local.files.createUpload(input),
    (error) => error instanceof TiDBLinkApiError && error.status === 409,
  );
  const corrupt = await local.files.createUpload(metadata(bytes));
  await assert.rejects(
    local.files.uploadContent(corrupt.uploadId, Buffer.from("wrong")),
    (error) =>
      error instanceof TiDBLinkApiError && [400, 422].includes(error.status),
  );
  assert.notEqual(
    (await local.files.getUpload(corrupt.uploadId)).file.status,
    "ready",
  );
});

test("actual large-file content returns a bearer download ticket that the SDK redeems without a key", async () => {
  const bytes = Buffer.alloc(50 * 1024 * 1024 + 1, 97);
  const file = await local.files.upload({
    originalName: "large.bin",
    bytes,
    idempotencyKey: randomUUID(),
  });
  const content = await local.files.getContent(file.fileId);
  assert.equal(content.type, "download");
  assert.equal(content.grant.byteSize, bytes.length);
  assert.deepEqual(
    Buffer.from(await local.files.downloadFromGrant(content.grant)),
    bytes,
  );
});

test("actual provider content corruption cannot become a ready file", async () => {
  await assert.rejects(
    remote.files.upload({
      originalName: "corrupt.txt",
      bytes: Buffer.from("corruption must be detected"),
      idempotencyKey: randomUUID(),
    }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "upload_integrity_failed",
  );
});

test("the installed upload example includes file content in its conversation", async () => {
  const session = await newSession();
  const unique = `example-file-${randomUUID()}`;
  const result = await uploadFileWorkflow({
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    sessionId: session.id,
    originalName: "example.txt",
    bytes: Buffer.from(unique),
    idempotencyKey: randomUUID(),
    clientEventId: randomUUID(),
    timeoutMs: 20000,
  });
  assert.equal(result.file.status, "ready");
  assert(result.result.text.includes(unique), result.result.text);
});
