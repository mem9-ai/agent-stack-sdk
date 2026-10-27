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
  assert(files.includes("examples/provision-user.mjs"));
  assert(!files.some((file) => file.includes("workspace")));
  assert(
    files.every(
      (file) =>
        file === "LICENSE" ||
        file === "README.md" ||
        file === "package.json" ||
        file === "examples/provision-user.mjs" ||
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
    `import type {
      Agent,
      AgentConfigPatch,
      TemplateContent,
      HardwareRequirement,
      PublicAgentConfig,
      Organization,
      EndUser,
      IssuedUserApiKey,
      UserApiKey,
      Session,
      TurnResult,
    } from "@mem9/tidb-link";
    import {
      TIDB_LINK_API_VERSION,
      TIDB_LINK_REVISION,
      TIDB_LINK_PROVISIONING_REVISION,
      TiDBLinkApiError,
      TiDBLinkError,
      OrganizationClient,
      UserClient,
    } from "@mem9/tidb-link";
    // @ts-expect-error Previous compatibility constants and error exports have no aliases.
    import { AGENT_SERVICE_API_VERSION, AGENT_SERVICE_REVISION, AgentStackError, AgentStackApiError } from "@mem9/tidb-link";
    // @ts-expect-error Workspace authority was removed from the supported SDK.
    import { WorkspaceClient } from "@mem9/tidb-link";

    declare const baseUrl: string;
    declare const organizationApiKey: string;
    const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
    declare const userApiKey: string;
    async function provisionEndUser(): Promise<EndUser> {
      const current: Organization = await organization.getOrganization();
      const created: EndUser = await organization.createEndUser({
        externalId: "customer_1", displayName: "Customer",
      });
      const users: EndUser[] = await organization.listEndUsers();
      const found: EndUser = await organization.getEndUser(created.userId);
      const issued: IssuedUserApiKey = await organization.createUserApiKey(created.userId, { name: "backend" });
      const keys: UserApiKey[] = await organization.listUserApiKeys(created.userId);
      const rotated: IssuedUserApiKey = await organization.rotateUserApiKey(issued.apiKey.apiKeyId);
      const revoked: UserApiKey = await organization.revokeUserApiKey(rotated.apiKey.apiKeyId);
      void current; void users; void keys; void revoked;
      return found;
    }
    declare const publicConfig: PublicAgentConfig;
    async function retainedUserWorkflow(): Promise<TurnResult> {
      const user = new UserClient({ baseUrl, apiKey: userApiKey });
      const agents: Agent[] = await user.listAgents();
      const agent = agents[0] ?? await user.createAgent({ agentTemplateId: "template_1", templateVersion: 1, name: "Customer Agent" });
      const requirement: HardwareRequirement = {definitionId:"hdef_"+"a".repeat(32),capabilityNames:["set_level"]};
      const config: AgentConfigPatch = { memory: { enabled: true }, hardware:{requirements:[requirement]} };
      const published = await user.getPublishedTemplateVersion("template_1",1);
      const content: TemplateContent = published.content;
      void content;
      // @ts-expect-error Content version 1 cannot declare Hardware.
      const invalidContent: TemplateContent = { ...published.content,schemaVersion:"agent-template-content@1",hardware:{requirements:[]} };
      // @ts-expect-error Every new Agent needs an explicit Template selector.
      user.createAgent({name:"Missing selection"});
      void invalidContent;
      await agent.configure(config);
      const session: Session = await agent.createSession();
      return session.turn({ text: "Hello" });
    }
    // @ts-expect-error Retired Service User handles are not an Organization capability.
    organization.serviceUser("user_1");
    // @ts-expect-error Native End User creation replaces the retired Service User operation.
    organization.createServiceUser({ displayName: "Customer" });
    // @ts-expect-error Project selection was removed from User authority.
    new UserClient({ baseUrl, apiKey: "ti_user_key_${"x".repeat(43)}", projectId: "removed" });
    // @ts-expect-error Runtime selection is not an Agent configuration capability.
    const removedRuntime: AgentConfigPatch = { runtime: { backend: "codex", authId: "removed" } };
    declare const session: Session;
    // @ts-expect-error Historical Session models cannot be selected for new Runs.
    session.setModel("gpt-5.4");
    // @ts-expect-error Structured Turn output is not supported.
    session.turn({ text: "Hello", outputSchema: { type: "object" } });
    void TIDB_LINK_API_VERSION;
    void TIDB_LINK_REVISION;
    void TIDB_LINK_PROVISIONING_REVISION;
    const apiError: TiDBLinkError = new TiDBLinkApiError({ status: 400, code: "test", message: "safe" });
    void apiError;
    void publicConfig;
    void WorkspaceClient;
    void removedRuntime;
    void provisionEndUser;
    void retainedUserWorkflow;
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
  assert.equal(
    installedPackage.tidbLinkProvisioningRevision,
    "b59a0a584eb2632b8d9c6d0808b8ea26081b1474",
  );
  assert.equal(
    installedPackage.tidbLinkProvisioningOpenApiSha256,
    "ce6ac6c2b1e2e50461455a85eb4aedffd8958019d15ef95e6b8254eaef54a9dc",
  );
  assert.equal(installedPackage.name, "@mem9/tidb-link");
  assert.match(installedPackage.version, /^0\./);
  assert.equal(installedPackage.type, "module");
  assert.equal(installedPackage.engines.node, ">=22.12");
  assert.deepEqual((await readdir(installedRoot)).sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "examples",
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

  await writeFile(
    path.join(temporary, "consumer.mjs"),
    `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import * as sdk from "@mem9/tidb-link";
    assert.equal(sdk.TIDB_LINK_API_VERSION, "0.0.1");
    assert.equal(sdk.TIDB_LINK_REVISION, ${JSON.stringify(installedPackage.tidbLinkRevision)});
    assert.equal(sdk.TIDB_LINK_PROVISIONING_REVISION, ${JSON.stringify(installedPackage.tidbLinkProvisioningRevision)});
    const { provisionUser } = await import("@mem9/tidb-link/examples/provision-user.mjs");
    assert.equal(typeof provisionUser, "function");
    assert.equal(sdk.ServiceUser, undefined);
    for (const name of ["AGENT_SERVICE_API_VERSION", "AGENT_SERVICE_REVISION", "AgentStackError", "AgentStackApiError"]) {
      assert.equal(sdk[name], undefined);
    }
    const orgKey = "ti_org_key_" + "x".repeat(43);
    const userKey = "ti_user_key_" + "y".repeat(43);
    const rotatedKey = "ti_user_key_" + "z".repeat(43);
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, key: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/agents") {
        response.end(JSON.stringify({ agents: [] }));
      } else {
        const token = request.url.endsWith("/rotate") ? rotatedKey : userKey;
        response.writeHead(201).end(JSON.stringify({ apiKey: { apiKeyId: "uak_key" }, token }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const org = new sdk.OrganizationClient({ baseUrl, apiKey: orgKey });
      const { token } = await org.createUserApiKey("user_1", { name: "test" });
      assert.equal(token, userKey);
      const user = new sdk.UserClient({ baseUrl, apiKey: token });
      assert.deepEqual(await user.listAgents(), []);
      const rotated = await org.rotateUserApiKey("uak_key");
      assert.equal(rotated.token, rotatedKey);
      assert.deepEqual(await new sdk.UserClient({ baseUrl, apiKey: rotated.token }).listAgents(), []);
      assert.deepEqual(requests, [
        {method:"POST",url:"/api/v1/org/users/user_1/api-keys",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/agents",key:"Bearer " + userKey},
        {method:"POST",url:"/api/v1/org/user-api-keys/uak_key/rotate",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/agents",key:"Bearer " + rotatedKey},
      ]);
      for (const [Client, apiKey] of [[sdk.UserClient, orgKey], [sdk.OrganizationClient, "ag9_oak." + "key." + "x".repeat(32)]]) {
        assert.throws(() => new Client({baseUrl,apiKey}), (error) => {
          assert(error instanceof TypeError);
          assert(!String(error).includes(apiKey));
          assert(!JSON.stringify(error).includes(apiKey));
          return true;
        });
      }
      assert.equal(requests.length, 4);
      for (const client of [org, user]) {
        for (const key of [orgKey, userKey, rotatedKey]) assert(!JSON.stringify(client).includes(key));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  `,
  );
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: temporary,
    stdio: "pipe",
  });
});
