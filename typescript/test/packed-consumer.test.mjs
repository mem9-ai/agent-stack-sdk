import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the packed SDK installs and typechecks in a clean ESM consumer", async (context) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "tidb-link-sdk-consumer-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const pack = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  )[0];
  const files = pack.files.map(({ path: file }) => file).sort();
  assert(files.includes("LICENSE"));
  assert(files.includes("README.md"));
  assert(files.includes("package.json"));
  assert(files.includes("dist/index.js"));
  assert(files.includes("dist/index.d.ts"));
  assert(!files.some((file) => file.includes("workspace")));
  assert(
    files.every(
      (file) =>
        file === "LICENSE" ||
        file === "README.md" ||
        file === "package.json" ||
        /^dist\/.+\.(?:js|d\.ts|map)$/.test(file),
    ),
  );

  const tarball = path.join(temporary, pack.filename);
  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    {
      cwd: temporary,
      stdio: "pipe",
    },
  );

  await writeFile(
    path.join(temporary, "consumer.ts"),
    `import type { Agent, AgentRecord, AgentTemplatePage, BusinessUser, BusinessUserRecord, Session, SessionRecord, SessionTemplateProvenance, TurnResult } from "@mem9/tidb-link";
    import { TIDB_LINK_API_VERSION, TIDB_LINK_REVISION, TiDBLinkApiError, TiDBLinkError, OrganizationClient, UserClient } from "@mem9/tidb-link";
    // @ts-expect-error Previous public behavior types and ServiceUser have no aliases.
    import { AgentConfigPatch, TemplateContent, HardwareRequirement, PublicAgentConfig, ServiceUser, ApplyTemplateInput, SelectableSessionModel } from "@mem9/tidb-link";
    // @ts-expect-error Previous compatibility constants and error exports have no aliases.
    import { AGENT_SERVICE_API_VERSION, AGENT_SERVICE_REVISION, AgentStackError, AgentStackApiError, WorkspaceClient } from "@mem9/tidb-link";
    declare const baseUrl: string;
    declare const organizationApiKey: string;
    const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
    async function quickStart(): Promise<TurnResult> {
      await organization.getOrganization();
      const businessUser: BusinessUser = await organization.createBusinessUser({ displayName: "Customer", externalId: "customer-42" });
      const record: Readonly<BusinessUserRecord> | undefined = businessUser.data;
      const existing: BusinessUser[] = await organization.listBusinessUsers();
      await organization.getBusinessUser(businessUser.id);
      const { token } = await businessUser.createApiKey({ name: "backend" });
      const user = new UserClient({ baseUrl, apiKey: token });
      const summaries: AgentTemplatePage = await user.listAgentTemplates({ limit: 20 });
      const agent: Agent = await user.createAgent({ agentTemplateId: summaries.templates[0]!.agentTemplateId });
      const association: Readonly<AgentRecord> = agent.data;
      const session: Session = await agent.createSession();
      const metadata: Readonly<SessionRecord> | undefined = session.data;
      const provenance: SessionTemplateProvenance | null | undefined = metadata?.template;
      // @ts-expect-error Public Session metadata excludes the private execution recipe.
      void metadata?.executionConfiguration;
      void provenance;
      await user.listSessions();
      await session.rename("Support");
      await session.setBillingTag(null);
      await user.validateMemoryKey("test-memory-key");
      await agent.revealMemoryKey();
      await agent.replaceMemoryKey("replacement-memory-key");
      void record; void existing; void association; void metadata;
      return session.turn({ text: "Hello" });
    }
    const user = new UserClient({ baseUrl, apiKey: "from-secret-manager" });
    // @ts-expect-error Every new Agent requires a Template association.
    user.createAgent({});
    // @ts-expect-error Published version is selected at Session creation by the service.
    user.createAgent({ agentTemplateId: "template_1", templateVersion: 1 });
    // @ts-expect-error Ordinary behavior belongs to the published Template.
    user.createAgent({ agentTemplateId: "template_1", config: {} });
    // @ts-expect-error Model selection belongs to the published Template.
    user.createAgent({ agentTemplateId: "template_1", model: "gpt-5.6-sol" });
    // @ts-expect-error Organization identity comes from the key.
    organization.createBusinessUser({ organizationId: "foreign" });
    declare const agent: Agent;
    // @ts-expect-error Agent association has no configuration mutation.
    agent.configure({});
    // @ts-expect-error Published content is not a public summary.
    user.getPublishedTemplateVersion("template_1", 1);
    declare const session: Session;
    // @ts-expect-error Session execution model is fixed.
    session.setModel("gpt-5.6-sol");
    // @ts-expect-error Session creation does not choose a model.
    agent.createSession({ model: "gpt-5.6-sol" });
    // @ts-expect-error Structured Turn output is unsupported.
    session.turn({ text: "Hello", outputSchema: { type: "object" } });
    void TIDB_LINK_API_VERSION; void TIDB_LINK_REVISION;
    const apiError: TiDBLinkError = new TiDBLinkApiError({ status: 400, code: "test", message: "safe" });
    void apiError; void quickStart;
    `,
  );
  const tsc = path.join(
    repositoryRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  execFileSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      "--lib",
      "ES2023,DOM,DOM.Iterable",
      "consumer.ts",
    ],
    { cwd: temporary, encoding: "utf8", stdio: "pipe" },
  );

  const installedRoot = path.join(
    temporary,
    "node_modules",
    "@mem9",
    "tidb-link",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.tidbLinkApiVersion, "0.0.1");
  assert.equal(
    installedPackage.tidbLinkRevision,
    "49f2bb3b7d194ada614cf9caa0a79f24e7aeba87",
  );
  assert.match(installedPackage.version, /^0\./);
  assert.deepEqual((await readdir(installedRoot)).sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "package.json",
  ]);

  const publishedFiles = await readdir(installedRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const credentialPattern =
    /ti_(?:org|user)_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43}|ag9_oak\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{32,}|ag9_uak_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{32,}/;
  for (const file of publishedFiles) {
    if (!file.isFile()) continue;
    const contents = await readFile(
      path.join(file.parentPath, file.name),
      "utf8",
    );
    assert.doesNotMatch(contents, credentialPattern);
  }

  await writeFile(path.join(temporary, "consumer.mjs"), `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import * as sdk from "@mem9/tidb-link";
    assert.equal(sdk.TIDB_LINK_API_VERSION, "0.0.1");
    assert.equal(sdk.TIDB_LINK_REVISION, ${JSON.stringify(installedPackage.tidbLinkRevision)});
    for (const name of ["AGENT_SERVICE_API_VERSION", "AGENT_SERVICE_REVISION", "AgentStackError", "AgentStackApiError"]) {
      assert.equal(sdk[name], undefined);
    }
    const orgKey = "ti_org_key_" + "x".repeat(43);
    const userKey = "ti_user_key_" + "y".repeat(43);
    const rotatedKey = "ti_user_key_" + "z".repeat(43);
    const requests = [];
    const businessUserRecord = { userId: "busr_1", organizationId: "org_1", displayName: "Customer", externalId: "customer-42", status: "active" };
    const association = { agentId: "agent_1", organizationId: "org_1", ownerUserId: "busr_1", agentTemplateId: "template_1", status: "active" };
    const sessionRecord = { sessionId: "session_1", template: { templateId: "template_1", version: 2, contentDigest: "a".repeat(64) }, model: "gpt-5.6-sol", createdWithAgentId: "agent_1", status: "active", name: null, billingTag: null };
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, url: request.url, key: request.headers.authorization, body: body ? JSON.parse(body) : null });
      response.setHeader("content-type", "application/json");
      if (request.url.endsWith("/api-keys") || request.url.endsWith("/rotate")) return response.end(JSON.stringify({ apiKey: { apiKeyId: "uak_key" }, token: request.url.endsWith("/rotate") ? rotatedKey : userKey }));
      if (request.url === "/api/v1/organization") return response.end(JSON.stringify({ organization: { organizationId: "org_1" } }));
      if (request.url.startsWith("/api/v1/organization/users")) return response.end(JSON.stringify(request.method === "GET" && request.url === "/api/v1/organization/users" ? { users: [businessUserRecord] } : { user: businessUserRecord }));
      if (request.url === "/api/v1/agent-templates") return response.end(JSON.stringify({ templates: [{ agentTemplateId: "template_1", displayName: "Support", description: "Support", latestPublishedVersion: 2 }], hasMore: false, nextCursor: null }));
      if (request.url === "/api/v1/agents" && request.method === "GET") return response.end(JSON.stringify({ agents: [association] }));
      if (request.url.startsWith("/api/v1/agents")) return response.end(JSON.stringify({ agent: request.method === "DELETE" ? { ...association, status: "archived" } : association }));
      if (request.url === "/api/v1/sessions" && request.method === "GET") return response.end(JSON.stringify({ sessions: [sessionRecord] }));
      response.end(JSON.stringify({ session: sessionRecord }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const org = new sdk.OrganizationClient({ baseUrl, apiKey: orgKey });
      assert.equal((await org.getOrganization()).organizationId, "org_1");
      const businessUser = await org.createBusinessUser({ externalId: "customer-42" });
      assert(businessUser instanceof sdk.BusinessUser);
      assert.equal((await org.getBusinessUser(businessUser.id)).id, "busr_1");
      assert.equal((await org.listBusinessUsers()).length, 1);
      const { token } = await businessUser.createApiKey({ name: "test" });
      assert.equal(token, userKey);
      const user = new sdk.UserClient({ baseUrl, apiKey: token });
      const page = await user.listAgentTemplates();
      const agent = await user.createAgent({ agentTemplateId: page.templates[0].agentTemplateId });
      assert.equal((await user.listAgents())[0].id, agent.id);
      assert.equal((await user.getAgent(agent.id)).id, agent.id);
      const session = await agent.createSession();
      assert.deepEqual(session.data.template, { templateId: "template_1", version: 2, contentDigest: "a".repeat(64) });
      assert.equal((await user.listSessions())[0].id, session.id);
      await session.refresh(); await session.rename("Support"); await session.setBillingTag(null); await session.delete(); await agent.unlink();
      assert.equal(agent.data.status, "archived");
      const rotated = await businessUser.rotateApiKey("uak_key");
      assert.equal(rotated.token, rotatedKey);
      assert.equal((await new sdk.UserClient({ baseUrl, apiKey: rotated.token }).listAgents()).length, 1);
      assert.equal(requests[1].url, "/api/v1/organization/users");
      assert.deepEqual(requests[1].body, { externalId: "customer-42" });
      assert.deepEqual(requests[6].body, { agentTemplateId: "template_1" });
      assert.equal(requests.at(-1).key, "Bearer " + rotatedKey);
      assert(requests.every(request => request.url.startsWith("/api/v1/")));
      for (const name of ["ServiceUser", "WorkspaceClient"]) assert.equal(sdk[name], undefined);
      for (const method of ["configure", "applyTemplate", "previewTemplateApplication", "rename", "archive", "makeDefault"]) assert.equal(agent[method], undefined);
      assert.equal(session.setModel, undefined);
      for (const [Client, apiKey] of [[sdk.UserClient, orgKey], [sdk.OrganizationClient, "ag9_oak." + "key." + "x".repeat(32)]]) {
        assert.throws(() => new Client({baseUrl,apiKey}), (error) => {
          assert(error instanceof TypeError);
          assert(!String(error).includes(apiKey));
          assert(!JSON.stringify(error).includes(apiKey));
          return true;
        });
      }
      for (const client of [org, user]) {
        for (const key of [orgKey, userKey, rotatedKey]) assert(!JSON.stringify(client).includes(key));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  `);
  execFileSync(process.execPath, ["consumer.mjs"], {cwd: temporary, stdio: "pipe"});
});
