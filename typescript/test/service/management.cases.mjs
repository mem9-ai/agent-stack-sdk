import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConflictError, OrganizationClient, TiDBLinkApiError } from "@tidblink/server";

const baseUrl = process.env.SDK_SERVICE_URL;
const apiKey = process.env.SDK_ORGANIZATION_KEY;
const foreignApiKey = process.env.SDK_FOREIGN_ORGANIZATION_KEY;
const userId = process.env.SDK_USER_ID;
assert(baseUrl && apiKey && foreignApiKey && userId, "Run this suite through npm run test:service");

// A minimal stored (uncompressed) ZIP writer for Skill package fixtures.
const table = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** @param {{ path: string, content: string }[]} entries */
export const zip = (entries) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(content.length, 20);
    record.writeUInt32LE(content.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0x81a40000, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
};

const skillPackage = (name) =>
  zip([
    {
      path: "SKILL.md",
      content: `---\nname: ${name}\ndescription: SDK management fixture Skill.\n---\n\nAnswer briefly.\n`,
    },
  ]);
const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

test("an Organization uploads, validates and publishes a Skill, and cancels another upload", async () => {
  const organization = new OrganizationClient({ baseUrl, apiKey });
  const bytes = skillPackage(id("sdk_skill"));
  const idempotencyKey = id("upload");
  const created = await organization.skills.upload({ bytes, idempotencyKey });
  assert.equal(created.byteSize, bytes.length);
  assert.equal(created.sha256, createHash("sha256").update(bytes).digest("hex"));
  const replay = await organization.skills.upload({ bytes, idempotencyKey });
  assert.equal(replay.uploadId, created.uploadId);

  const validated = await organization.skills.waitForUpload(created.uploadId, {
    intervalMs: 250,
    timeoutMs: 30_000,
  });
  assert.equal(validated.state, "awaiting_confirmation", JSON.stringify(validated.validation));

  const publishKey = id("publish");
  await organization.skills.publish(created.uploadId, { idempotencyKey: publishKey });
  const done = await organization.skills.waitForUpload(created.uploadId, {
    until: ["done", "failed", "aborted"],
    intervalMs: 250,
    timeoutMs: 30_000,
  });
  assert.equal(done.state, "done");
  assert.equal(done.version, 1);

  const detail = await organization.skills.get(created.skillId);
  assert.equal(detail.skill.skillId, created.skillId);
  assert.equal(detail.skill.headVersion, 1);
  assert.deepEqual(detail.versions.map((version) => version.version), [1]);
  const listed = [];
  let cursor;
  do {
    const page = await organization.skills.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    listed.push(...page.skills);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert(listed.some((skill) => skill.skillId === created.skillId));

  const foreign = new OrganizationClient({ baseUrl, apiKey: foreignApiKey });
  await assert.rejects(
    foreign.skills.getUpload(created.uploadId),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );

  const other = await organization.skills.upload({
    bytes: skillPackage(id("sdk_cancelled")),
    idempotencyKey: id("upload"),
  });
  await organization.skills.waitForUpload(other.uploadId, { intervalMs: 250, timeoutMs: 30_000 });
  await organization.skills.cancelUpload(other.uploadId);
  const cancelled = await organization.skills.getUpload(other.uploadId);
  assert.equal(cancelled.state, "aborted");
});

test("an Organization creates, replaces and archives a Template and starts a Session from it", async () => {
  const organization = new OrganizationClient({ baseUrl, apiKey });
  const catalog = await organization.templates.catalog();
  const sandbox = catalog.sandboxes[0];
  assert(sandbox, "The deployment must offer a Sandbox profile");
  const content = {
    identity: { agentName: "SDK Template" },
    instructions: "Reply with SDK_FIXTURE.",
    sandbox: { profileId: sandbox.id },
    realtime: { language: "en-US" },
  };
  const creation = { displayName: `SDK Template ${randomUUID()}`, content, idempotencyKey: id("template") };
  const created = await organization.templates.create(creation);
  assert.equal(created.template.lifecycleStatus, "active");
  assert.equal(created.content.instructions, content.instructions);
  const replay = await organization.templates.create(creation);
  assert.equal(replay.template.id, created.template.id);
  assert.deepEqual(await organization.templates.get(created.template.id), replay);
  const page = await organization.templates.list({ q: creation.displayName, lifecycleStatus: "active" });
  assert.deepEqual(page.data.map((template) => template.id), [created.template.id]);

  const replaced = await organization.templates.replace(
    created.template.id,
    { displayName: creation.displayName, content: { ...content, instructions: "Reply with SDK_FIXTURE twice." } },
    { ifMatch: created.template.etag, idempotencyKey: id("replace") },
  );
  assert.notEqual(replaced.template.etag, created.template.etag);
  assert.equal(replaced.content.instructions, "Reply with SDK_FIXTURE twice.");
  await assert.rejects(
    organization.templates.replace(
      created.template.id,
      { displayName: creation.displayName, content },
      { ifMatch: created.template.etag, idempotencyKey: id("stale") },
    ),
    ConflictError,
  );

  const user = organization.user(userId);
  const agent = await user.createAgent({
    agentTemplateId: created.template.id,
    idempotencyKey: id("agent"),
  });
  const session = await agent.createSession({ idempotencyKey: id("session") });
  assert.equal(session.data.template?.templateId, created.template.id);
  assert.equal(session.data.template?.contentDigest, replaced.template.contentDigest);

  const archived = await organization.templates.archive(created.template.id, {
    ifMatch: replaced.template.etag,
    idempotencyKey: id("archive"),
  });
  assert.equal(archived.template.lifecycleStatus, "archived");
  const foreign = new OrganizationClient({ baseUrl, apiKey: foreignApiKey });
  await assert.rejects(
    foreign.templates.get(created.template.id),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});
