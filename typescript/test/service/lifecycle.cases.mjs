import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  OrganizationClient,
  UserClient,
  TiDBLinkApiError,
  ConflictError,
} from "@mem9/tidb-link";
import { createSessionWorkflow } from "@mem9/tidb-link/examples/create-session.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const templateId = process.env.SDK_TEMPLATE_ID;
const otherTemplateId = process.env.SDK_OTHER_TEMPLATE_ID;
assert(
  baseUrl && templateId && otherTemplateId,
  "Run through npm run test:service",
);
const user = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const stranger = new UserClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_USER_KEY,
});
const organization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
});
const foreignOrg = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_FOREIGN_ORGANIZATION_KEY,
});
const refusal = (status, code) => (error) =>
  error instanceof TiDBLinkApiError &&
  error.status === status &&
  error.code === code &&
  !!error.requestId;

test("the installed SDK selects Templates, creates independent Agents and updates owner preferences", async () => {
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
  const input = { agentTemplateId: templateId, idempotencyKey: randomUUID() };
  const first = await user.createAgent(input);
  const recovered = await user.createAgent(input);
  const second = await user.createAgent({
    ...input,
    idempotencyKey: randomUUID(),
  });
  assert.equal(recovered.id, first.id);
  assert.notEqual(second.id, first.id);
  assert.equal(first.data.additionalInstructions, undefined);
  await assert.rejects(
    user.createAgent({ ...input, agentTemplateId: otherTemplateId }),
    refusal(409, "agent_creation_conflict"),
  );
  assert((await user.listAgents()).some((a) => a.id === first.id));
  const owned = await user.getAgent(first.id);
  assert.equal(owned.data.additionalInstructions, "");
  await owned.update({ additionalInstructions: "  Concise\r\nanswers.  " });
  assert.equal(owned.data.additionalInstructions, "Concise\nanswers.");
  assert.equal(
    (await user.getAgent(first.id)).data.additionalInstructions,
    "Concise\nanswers.",
  );
  assert.equal(
    (await user.getAgent(second.id)).data.additionalInstructions,
    "",
  );
  await assert.rejects(
    owned.update({ additionalInstructions: "中".repeat(1366) }),
    refusal(400, "validation_error"),
  );
  await owned.update({ additionalInstructions: null });
  assert.equal(owned.data.additionalInstructions, "");
  await assert.rejects(
    stranger.getAgent(first.id),
    refusal(404, "agent_not_found"),
  );
  const foreignHandle = stranger.session("missing");
  await assert.rejects(
    foreignHandle.refresh(),
    refusal(404, "session_not_found"),
  );
  await assert.rejects(
    foreignOrg.unlinkAgent(first.data.ownerUserId, first.id),
    refusal(404, "agent_not_found"),
  );
  await assert.rejects(
    organization.unlinkAgent(second.data.ownerUserId + "missing", first.id),
    refusal(404, "agent_not_found"),
  );
  const archived = await organization.unlinkAgent(
    first.data.ownerUserId,
    first.id,
  );
  assert.equal(archived.status, "archived");
  assert.equal((await user.createAgent(input)).status, "archived");
  await assert.rejects(
    user.getAgent(first.id),
    refusal(404, "agent_not_found"),
  );
  assert(!(await user.listAgents()).some((a) => a.id === first.id));
});

test("owned Sessions preserve creation identity, paging, conditional model edits, names, tags and history after unlink", async () => {
  const agent = await user.createAgent({
    agentTemplateId: templateId,
    idempotencyKey: randomUUID(),
  });
  const models = await user.listModels({ agentId: agent.id });
  const model = models.effectiveDefaultModel;
  const nextModel = models.effectiveAllowedModels.find((id) => id !== model);
  assert(nextModel, "Controlled release must serve two models");
  const options = {
    idempotencyKey: randomUUID(),
    model,
    billingTag: { key: "customer", value: "one" },
  };
  const session = await agent.createSession(options);
  assert.equal((await agent.createSession(options)).id, session.id);
  assert.equal(session.data.createdWithAgentId, agent.id);
  assert.equal(session.data.template.templateId, templateId);
  const digest = session.data.template.contentDigest;
  await assert.rejects(
    agent.createSession({ ...options, model: nextModel }),
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
  assert.equal((await agent.createSession(options)).id, session.id);
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
  await agent.update({ additionalInstructions: "Future Sessions only" });
  const later = await agent.createSession({ idempotencyKey: randomUUID() });
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
  await organization.unlinkAgent(agent.data.ownerUserId, agent.id);
  const retained = await user.getSession(session.id);
  assert.equal(retained.data.createdWithAgentId, agent.id);
  assert.equal(retained.data.template.contentDigest, digest);
  await assert.rejects(
    agent.createSession({ idempotencyKey: randomUUID() }),
    (error) => error instanceof TiDBLinkApiError && error.status === 404,
  );
  // Reads and lifecycle ownership survive unlink; execution does not acquire a new Agent.
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

test("the installed Template-to-Agent-to-Session example is runnable and recoverable without message execution", async () => {
  const options = {
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    agentCreationKey: randomUUID(),
    sessionCreationKey: randomUUID(),
  };
  const first = await createSessionWorkflow(options);
  const second = await createSessionWorkflow(options);
  assert.equal(first.agent.id, second.agent.id);
  assert.equal(first.session.id, second.session.id);
  assert.equal(
    (await user.getSession(first.session.id)).data.createdWithAgentId,
    first.agent.id,
  );
  const executable = fileURLToPath(
    import.meta.resolve("@mem9/tidb-link/examples/create-session.mjs"),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [executable],
    {
      env: {
        ...process.env,
        AGENT_SERVICE_URL: baseUrl,
        USER_API_KEY: options.userApiKey,
        AGENT_CREATION_KEY: options.agentCreationKey,
        SESSION_CREATION_KEY: options.sessionCreationKey,
      },
    },
  );
  assert.equal(JSON.parse(stdout).sessionId, first.session.id);
  assert(!(stdout + stderr).includes(options.userApiKey));
});
