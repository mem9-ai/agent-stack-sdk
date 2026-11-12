import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError, ConflictError } from "@tidblink/server";
import { createSessionWorkflow } from "@tidblink/server/examples/create-session.mjs";
import { sendMessageWorkflow } from "@tidblink/server/examples/send-message.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const apiKey = process.env.SDK_ORGANIZATION_KEY;
const foreignApiKey = process.env.SDK_FOREIGN_ORGANIZATION_KEY;
assert(
  baseUrl && apiKey && foreignApiKey,
  "Run this suite through npm run test:service",
);

const refusal = (status, code) => (error) =>
  error instanceof TiDBLinkApiError &&
  error.status === status &&
  error.code === code &&
  typeof error.requestId === "string" &&
  error.requestId.length > 0;

test("End User provisioning and Organization-scoped identity work in an installed consumer", async () => {
  const organization = new OrganizationClient({ baseUrl, apiKey });
  const foreign = new OrganizationClient({ baseUrl, apiKey: foreignApiKey });
  const current = await organization.getOrganization();
  const other = await foreign.getOrganization();
  assert.equal(typeof current.organizationId, "string");
  assert.notEqual(current.organizationId, other.organizationId);
  const externalId = `sdk-${randomUUID()}`;
  const user = await organization.createEndUser({
    externalId: `  ${externalId}  `,
    displayName: " SDK User ",
  });
  assert.equal(user.externalId, externalId);
  assert.equal(user.displayName, "SDK User");
  assert.equal(user.organizationId, current.organizationId);
  assert.equal(user.status, "active");
  assert.deepEqual(await organization.getEndUser(user.userId), user);
  assert.deepEqual(
    (await organization.listEndUsers()).filter(
      (entry) => entry.externalId === externalId,
    ),
    [user],
  );
  // Creation is idempotent by externalId: the existing End User comes back
  // unchanged and the other fields are not applied.
  assert.deepEqual(
    await organization.createEndUser({ externalId, displayName: "Other" }),
    user,
  );
  const concurrent = `sdk-${randomUUID()}`;
  const [first, second] = await Promise.all([
    organization.createEndUser({ externalId: concurrent }),
    organization.createEndUser({ externalId: concurrent }),
  ]);
  assert.equal(first.userId, second.userId);
  await assert.rejects(
    organization.createEndUser({ externalId: externalId.toUpperCase() }),
    (error) =>
      error instanceof ConflictError &&
      refusal(409, "resource_conflict")(error),
  );
  const foreignUser = await foreign.createEndUser({ externalId });
  assert.notEqual(foreignUser.userId, user.userId);
  await assert.rejects(
    organization.getEndUser(foreignUser.userId),
    refusal(404, "resource_not_found"),
  );
});

test("one installed consumer provisions a new User and completes and recovers the full application quickstart", async () => {
  const organization = new OrganizationClient({ baseUrl, apiKey });
  const endUser = await organization.createEndUser({
    externalId: `sdk-quickstart-${randomUUID()}`,
  });
  const customer = organization.user(endUser.userId);
  const catalog = await customer.listAgentTemplates({ limit: 200 });
  const template = catalog.templates.find(
    (item) => item.agentTemplateId === process.env.SDK_TEMPLATE_ID,
  );
  assert(
    template,
    "The newly provisioned User must discover the available Template",
  );
  const models = await customer.listModels();
  assert(
    models.models.some((model) => model.model === models.effectiveDefaultModel),
  );
  const creation = {
    baseUrl,
    organizationApiKey: apiKey,
    userId: endUser.userId,
    templateId: template.agentTemplateId,
    sessionCreationKey: randomUUID(),
    model: models.effectiveDefaultModel,
  };
  const { session } = await createSessionWorkflow(creation);
  const input = {
    baseUrl,
    organizationApiKey: apiKey,
    userId: endUser.userId,
    sessionId: session.id,
    clientEventId: randomUUID(),
    text: "SDK_FIXTURE_SUCCESS",
    timeoutMs: 15000,
  };
  const result = await sendMessageWorkflow(input);
  assert.equal(result.text, "SDK final answer.");
  assert.equal(result.interaction.result.status, "succeeded");
  assert(result.interaction.appliedAt);
  const recovered = await createSessionWorkflow(creation);
  assert.equal(recovered.session.id, session.id);
  assert.deepEqual(
    await session.reconcileInteraction(input.clientEventId),
    result.interaction,
  );
  assert.deepEqual(await sendMessageWorkflow(input), result);
  const history = await recovered.session.history();
  assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0].id, result.turnId);
  assert.equal(history.turns[0].assistantMessage.content, result.text);
  assert.equal(recovered.session.data.ownerUserId, endUser.userId);
});
