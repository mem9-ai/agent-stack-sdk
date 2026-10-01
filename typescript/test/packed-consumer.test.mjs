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
    `import type {
      Agent,
      AgentConfigPatch,
      TemplateContent,
      HardwareRequirement,
      PublicAgentConfig,
      ServiceUser,
      Session,
      TurnResult,
    } from "@mem9/tidb-link";
    import {
      TIDB_LINK_API_VERSION,
      TIDB_LINK_REVISION,
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
    const serviceUser: ServiceUser = organization.serviceUser("user_1");
    declare const publicConfig: PublicAgentConfig;
    async function quickStart(): Promise<TurnResult> {
      const { token } = await serviceUser.createApiKey({ name: "backend" });
      const user = new UserClient({ baseUrl, apiKey: token });
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
    // @ts-expect-error Organization API Keys cannot create Service Users through the public contract.
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
    const apiError: TiDBLinkError = new TiDBLinkApiError({ status: 400, code: "test", message: "safe" });
    void apiError;
    void publicConfig;
    void WorkspaceClient;
    void removedRuntime;
    void serviceUser;
    void quickStart;
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
      const serviceUser = org.serviceUser("user_1");
      const { token } = await serviceUser.createApiKey({ name: "test" });
      assert.equal(token, userKey);
      const user = new sdk.UserClient({ baseUrl, apiKey: token });
      assert.deepEqual(await user.listAgents(), []);
      const rotated = await serviceUser.rotateApiKey("uak_key");
      assert.equal(rotated.token, rotatedKey);
      assert.deepEqual(await new sdk.UserClient({ baseUrl, apiKey: rotated.token }).listAgents(), []);
      assert.deepEqual(requests, [
        {method:"POST",url:"/api/admin/org/users/user_1/api-keys",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/agents",key:"Bearer " + userKey},
        {method:"POST",url:"/api/admin/org/user-api-keys/uak_key/rotate",key:"Bearer " + orgKey},
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
  `);
  execFileSync(process.execPath, ["consumer.mjs"], {cwd: temporary, stdio: "pipe"});
});
