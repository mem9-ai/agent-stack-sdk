import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError, ConflictError } from "@tidblink/server";
import { createSessionWorkflow } from "@tidblink/server/examples/create-session.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const templateId = process.env.SDK_TEMPLATE_ID;
const otherTemplateId = process.env.SDK_OTHER_TEMPLATE_ID;
assert(
  baseUrl && templateId && otherTemplateId,
  "Run through npm run test:service",
);
const user = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
}).user(process.env.SDK_USER_ID);
const stranger = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
}).user(process.env.SDK_FOREIGN_USER_ID);
const foreignOrg = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_ORGANIZATION_KEY,
});
const refusal = (status, code) => (error) =>
  error instanceof TiDBLinkApiError &&
  error.status === status &&
  error.code === code &&
  !!error.requestId;

test("the installed SDK selects Templates and creates Sessions with Session options", async () => {
  const templates = [];
  let cursor;
  do {
    const page = await user.listAgentTemplates({
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    templates.push(...page.templates);
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      break;
    }
    assert(page.nextCursor);
    assert.notEqual(cursor, page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  assert(templates.some((t) => t.agentTemplateId === templateId));
  assert(templates.some((t) => t.agentTemplateId === otherTemplateId));
  assert(templates.every((t) => /^[0-9a-f]{64}$/.test(t.contentDigest)));
  const models = await user.listModels();
  assert(
    models.models.some(
      (m) =>
        m.model === models.effectiveDefaultModel &&
        m.availability === "available",
    ),
  );
  const input = {
    templateId,
    idempotencyKey: randomUUID(),
    additionalInstructions: "  Concise\r\nanswers.  ",
    sandbox: { profileId: null, workingDirectory: "work" },
  };
  const first = await user.createSession(input);
  const recovered = await user.createSession(input);
  const second = await user.createSession({
    ...input,
    idempotencyKey: randomUUID(),
  });
  assert.equal(recovered.id, first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(first.data.template.templateId, templateId);
  await assert.rejects(
    user.createSession({ ...input, templateId: otherTemplateId }),
    refusal(409, "session_creation_conflict"),
  );
  await assert.rejects(
    user.createSession({
      templateId,
      idempotencyKey: randomUUID(),
      additionalInstructions: "中".repeat(1366),
    }),
    refusal(400, "validation_error"),
  );
  const other = await user.createSession({
    templateId: otherTemplateId,
    idempotencyKey: randomUUID(),
    additionalInstructions: null,
  });
  assert.equal(other.data.template.templateId, otherTemplateId);
  const onTemplate = await user.listSessions({ templateId, limit: 200 });
  assert(onTemplate.sessions.some((item) => item.id === first.id));
  assert(onTemplate.sessions.every((item) => item.data.template.templateId === templateId));
  const onOther = await user.listSessions({ templateId: otherTemplateId, limit: 200 });
  assert.deepEqual(
    onOther.sessions.map((item) => item.id).filter((id) => id === first.id),
    [],
  );
  assert(onOther.sessions.some((item) => item.id === other.id));
  await assert.rejects(
    stranger.getSession(first.id),
    refusal(404, "session_not_found"),
  );
  const foreignHandle = stranger.session("missing");
  await assert.rejects(
    foreignHandle.refresh(),
    refusal(404, "session_not_found"),
  );
  await assert.rejects(
    foreignOrg
      .user(process.env.SDK_USER_ID)
      .createSession({ templateId, idempotencyKey: randomUUID() }),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
});

test("owned Sessions preserve creation identity, paging, conditional model edits, names and tags", async () => {
  const models = await user.listModels();
  const model = models.effectiveDefaultModel;
  const nextModel = models.effectiveAllowedModels.find((id) => id !== model);
  assert(nextModel, "Controlled release must serve two models");
  const options = {
    templateId,
    idempotencyKey: randomUUID(),
    model,
    billingTag: { key: "customer", value: "one" },
  };
  const session = await user.createSession(options);
  assert.equal((await user.createSession(options)).id, session.id);
  assert.equal(session.data.template.templateId, templateId);
  const digest = session.data.template.contentDigest;
  await assert.rejects(
    user.createSession({ ...options, model: nextModel }),
    refusal(409, "session_creation_conflict"),
  );
  const stale = await user.getSession(session.id);
  await session.setModel(nextModel);
  assert.equal(session.model, nextModel);
  await assert.rejects(
    stale.setModel(model),
    (error) => error instanceof ConflictError && error.status === 412,
  );
  assert.equal(stale.model, model);
  assert.equal((await user.getSession(session.id)).model, nextModel);
  // Creation identity retains the original requested model even after selection changes.
  assert.equal((await user.createSession(options)).id, session.id);
  await session.suggestName({
    userText: "Plan a trip",
    assistantText: "Choose the destination",
  });
  assert(session.data.name);
  assert.equal(
    (await user.getSession(session.id)).data.name,
    session.data.name,
  );
  await session.rename("  Customer conversation  ");
  assert.equal(session.data.name, "Customer conversation");
  await session.setBillingTag({ key: "customer", value: "two" });
  assert.deepEqual(session.data.billingTag, { key: "customer", value: "two" });
  await session.setBillingTag(null);
  await session.setModel(model);
  assert.equal((await user.getSession(session.id)).data.billingTag, null);
  const later = await user.createSession({
    templateId,
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    (await user.getSession(session.id)).data.template.contentDigest,
    digest,
  );
  const firstPage = await user.listSessions({ limit: 1 });
  assert.equal(firstPage.hasMore, true);
  assert(firstPage.nextCursor);
  const secondPage = await user.listSessions({
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.notEqual(secondPage.sessions[0].id, firstPage.sessions[0].id);
  await assert.rejects(
    stranger.listSessions({ cursor: firstPage.nextCursor }),
    (error) => error instanceof TiDBLinkApiError && error.status === 400,
  );
  await assert.rejects(
    stranger.getSession(session.id),
    refusal(404, "session_not_found"),
  );
  await assert.rejects(
    stranger.session(session.id).rename("foreign"),
    refusal(404, "session_not_found"),
  );
  const retained = await user.getSession(session.id);
  assert.equal(retained.data.template.contentDigest, digest);
  await retained.rename("Retained conversation");
  assert.equal(
    (await user.getSession(session.id)).data.name,
    "Retained conversation",
  );
  await later.delete();
  assert.equal(later.data.status, "deleted");
  await assert.rejects(
    user.getSession(later.id),
    refusal(404, "session_not_found"),
  );
});

test("the installed Template-to-Session example is runnable and recoverable without message execution", async () => {
  const options = {
    baseUrl,
    organizationApiKey: process.env.SDK_ORGANIZATION_KEY,
    userId: process.env.SDK_USER_ID,
    templateId,
    sessionCreationKey: randomUUID(),
  };
  const first = await createSessionWorkflow(options);
  const second = await createSessionWorkflow(options);
  assert.equal(first.session.id, second.session.id);
  assert.equal(
    (await user.getSession(first.session.id)).data.template.templateId,
    templateId,
  );
  const executable = fileURLToPath(
    import.meta.resolve("@tidblink/server/examples/create-session.mjs"),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [executable],
    {
      env: {
        ...process.env,
        AGENT_SERVICE_URL: baseUrl,
        ORGANIZATION_API_KEY: options.organizationApiKey,
        END_USER_ID: options.userId,
        TEMPLATE_ID: options.templateId,
        SESSION_CREATION_KEY: options.sessionCreationKey,
      },
    },
  );
  assert.equal(JSON.parse(stdout).sessionId, first.session.id);
  assert(!(stdout + stderr).includes(options.organizationApiKey));
});
