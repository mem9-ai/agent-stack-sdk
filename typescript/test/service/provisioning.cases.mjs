import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  OrganizationClient,
  UserClient,
  TiDBLinkApiError,
  ConflictError,
} from "@mem9/tidb-link";
import { provisionUser } from "@mem9/tidb-link/examples/provision-user.mjs";
import { createSessionWorkflow } from "@mem9/tidb-link/examples/create-session.mjs";
import { sendMessageWorkflow } from "@mem9/tidb-link/examples/send-message.mjs";

const exec = promisify(execFile);
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
const userRequest = (token, route = "/api/v1/user/agents") =>
  fetch(new URL(route, baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
const assertMetadata = (value) => {
  assert.equal("token" in value, false);
  assert.equal("secretHash" in value, false);
};

test("provisioning, scoped identity and key lifecycle work in an installed consumer", async () => {
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
  await assert.rejects(
    organization.createEndUser({ externalId }),
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
  await assert.rejects(
    organization.listUserApiKeys(foreignUser.userId),
    refusal(400, "validation_error"),
  );
  await assert.rejects(
    organization.createUserApiKey(foreignUser.userId, { name: "Forbidden" }),
    refusal(400, "validation_error"),
  );

  const issued = await organization.createUserApiKey(user.userId, {
    name: " Backend ",
  });
  assert.equal(issued.apiKey.name, "Backend");
  assert.equal(issued.apiKey.userId, user.userId);
  assert.equal(issued.apiKey.createdByUserId, null);
  assert.equal(typeof issued.apiKey.createdByOrganizationApiKeyId, "string");
  assertMetadata(issued.apiKey);
  const list = await organization.listUserApiKeys(user.userId);
  assert.deepEqual(list, [issued.apiKey]);
  list.forEach(assertMetadata);
  assert.equal((await userRequest(issued.token)).status, 200);
  const wrongAuthority = await userRequest(issued.token, "/api/v1/org");
  assert.equal(wrongAuthority.status, 403);
  assert.equal((await wrongAuthority.json()).error.code, "auth_kind_forbidden");
  assert.throws(
    () => new OrganizationClient({ baseUrl, apiKey: issued.token }),
    TypeError,
  );
  await assert.rejects(
    foreign.rotateUserApiKey(issued.apiKey.apiKeyId),
    refusal(400, "validation_error"),
  );
  await assert.rejects(
    foreign.revokeUserApiKey(issued.apiKey.apiKeyId),
    refusal(400, "validation_error"),
  );
  const rotated = await organization.rotateUserApiKey(issued.apiKey.apiKeyId);
  assert.equal(rotated.apiKey.apiKeyId, issued.apiKey.apiKeyId);
  assert.equal(rotated.token === issued.token, false);
  assertMetadata(rotated.apiKey);
  assert.equal((await userRequest(issued.token)).status, 401);
  assert.equal((await userRequest(rotated.token)).status, 200);
  const revoked = await organization.revokeUserApiKey(issued.apiKey.apiKeyId);
  assert.equal(revoked.status, "revoked");
  assert.equal(typeof revoked.revokedAt, "string");
  assertMetadata(revoked);
  assert.equal((await userRequest(rotated.token)).status, 401);
  assert.equal(
    (await organization.revokeUserApiKey(issued.apiKey.apiKeyId)).status,
    "revoked",
  );
  await assert.rejects(
    organization.rotateUserApiKey(issued.apiKey.apiKeyId),
    refusal(400, "validation_error"),
  );
  assert.equal(
    (await organization.listUserApiKeys(user.userId))[0].status,
    "revoked",
  );

  const example = await provisionUser({
    baseUrl,
    organizationApiKey: apiKey,
    externalId,
  });
  assert.equal(example.organization.organizationId, current.organizationId);
  assert.equal(example.user.userId, user.userId);
  assert.equal((await userRequest(example.token)).status, 200);
  const fresh = await provisionUser({
    baseUrl,
    organizationApiKey: apiKey,
    externalId: `sdk-example-${randomUUID()}`,
  });
  assert.equal(fresh.user.organizationId, current.organizationId);
  assert.equal((await userRequest(fresh.token)).status, 200);
  await organization.revokeUserApiKey(example.apiKey.apiKeyId);
  await organization.revokeUserApiKey(fresh.apiKey.apiKeyId);
  const credentialFile = path.join(process.cwd(), "user-credential.json");
  const executable = fileURLToPath(
    import.meta.resolve("@mem9/tidb-link/examples/provision-user.mjs"),
  );
  const commandEnv = {
    ...process.env,
    AGENT_SERVICE_URL: baseUrl,
    ORGANIZATION_API_KEY: apiKey,
    END_USER_EXTERNAL_ID: `sdk-cli-${randomUUID()}`,
    USER_CREDENTIAL_FILE: credentialFile,
  };
  try {
    const output = await exec(process.execPath, [executable], {
      env: commandEnv,
    });
    const content = await readFile(credentialFile, "utf8");
    const saved = JSON.parse(content);
    assert.equal((await userRequest(saved.token)).status, 200);
    if (process.platform !== "win32") {
      assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
    }
    assert.equal((output.stdout + output.stderr).includes(saved.token), false);
    const count = (await organization.listUserApiKeys(saved.user.userId))
      .length;
    let rejectedOutput;
    await assert.rejects(
      exec(process.execPath, [executable], { env: commandEnv }),
      (error) => {
        rejectedOutput = (error.stdout ?? "") + (error.stderr ?? "");
        return error.code === 1;
      },
    );
    assert.equal(rejectedOutput.includes(saved.token), false);
    assert.equal((await readFile(credentialFile, "utf8")) === content, true);
    assert.equal(
      (await organization.listUserApiKeys(saved.user.userId)).length,
      count,
    );
    await organization.revokeUserApiKey(saved.apiKey.apiKeyId);
  } finally {
    await rm(credentialFile, { force: true });
  }
});

test("one installed consumer provisions a new User and completes and recovers the full application quickstart", async () => {
  const provisioned = await provisionUser({
    baseUrl,
    organizationApiKey: apiKey,
    externalId: `sdk-quickstart-${randomUUID()}`,
  });
  const customer = new UserClient({ baseUrl, apiKey: provisioned.token });
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
    userApiKey: provisioned.token,
    agentTemplateId: template.agentTemplateId,
    agentCreationKey: randomUUID(),
    sessionCreationKey: randomUUID(),
    model: models.effectiveDefaultModel,
  };
  const { agent, session } = await createSessionWorkflow(creation);
  const input = {
    baseUrl,
    userApiKey: provisioned.token,
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
  assert.equal(recovered.agent.id, agent.id);
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
  const organization = new OrganizationClient({ baseUrl, apiKey });
  assert.equal(
    (await organization.listUserApiKeys(provisioned.user.userId)).length,
    1,
  );
  await organization.revokeUserApiKey(provisioned.apiKey.apiKeyId);
});
