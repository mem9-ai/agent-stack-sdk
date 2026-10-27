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
    path.join(tmpdir(), "agent-stack-sdk-consumer-"),
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
  assert(!files.includes("dist/workspace.js"));
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
      ProjectRecord,
      PublicAgentConfig,
      EndUser,
      Organization,
      IssuedUserApiKey,
      UserApiKey,
      Session,
      TurnResult,
    } from "@mem9/agent-stack";
    import {
      listProjects,
      UserClient,
      OrganizationClient,
      AGENT_SERVICE_REVISION,
    } from "@mem9/agent-stack";

    declare const baseUrl: string;
    declare const organizationApiKey: string;
    const organizationClient = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
    type CodexRuntime = Extract<PublicAgentConfig["runtime"], { backend: "codex" }>;
    const effort: CodexRuntime["modelReasoningEffort"] = "high";
    async function quickStart(): Promise<TurnResult> {
      const organization: Organization = await organizationClient.getOrganization();
      const created: EndUser = await organizationClient.createEndUser({ displayName: "Customer", externalId: "customer" });
      const users: EndUser[] = await organizationClient.listEndUsers();
      const found: EndUser = await organizationClient.getEndUser(created.userId);
      const issued: IssuedUserApiKey = await organizationClient.createUserApiKey(created.userId, { name: "backend" });
      const keys: UserApiKey[] = await organizationClient.listUserApiKeys(created.userId);
      const rotated: IssuedUserApiKey = await organizationClient.rotateUserApiKey(issued.apiKey.apiKeyId);
      const revoked: UserApiKey = await organizationClient.revokeUserApiKey(rotated.apiKey.apiKeyId);
      void organization; void users; void found; void keys; void revoked;
      const { token } = issued;
      const projects: ProjectRecord[] = await listProjects({ baseUrl, apiKey: token });
      const project = projects[0];
      if (!project) throw new Error("No Project is available");
      const user = new UserClient({ baseUrl, apiKey: token, projectId: project.projectId });
      const agents: Agent[] = await user.listAgents();
      const agent = agents[0] ?? await user.createAgent({ name: "Customer Agent" });
      const config: AgentConfigPatch = { delegation: { enabled: true } };
      await agent.configure(config);
      const session: Session = await agent.createSession();
      return session.turn({ text: "Hello" });
    }
    void effort; void quickStart; void AGENT_SERVICE_REVISION;
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
    "agent-stack",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.agentServiceApiVersion, "0.0.1");
  assert.match(installedPackage.version, /^0\./);
  assert.equal(installedPackage.type, "module");
  assert.equal(installedPackage.engines.node, ">=22.12");
  assert.equal(
    installedPackage.agentServiceRevision,
    "b59a0a584eb2632b8d9c6d0808b8ea26081b1474",
  );
  assert.equal(
    installedPackage.agentServiceOpenApiSha256,
    "ce6ac6c2b1e2e50461455a85eb4aedffd8958019d15ef95e6b8254eaef54a9dc",
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import * as sdk from '@mem9/agent-stack';
    import {provisionUser} from '@mem9/agent-stack/examples/provision-user.mjs';
    assert.equal(typeof sdk.OrganizationClient, 'function');
    assert.equal(typeof provisionUser, 'function');
    assert.equal(sdk.WorkspaceClient, undefined);
    assert.equal(sdk.ServiceUser, undefined);
    assert.equal(sdk.AGENT_SERVICE_REVISION, '${installedPackage.agentServiceRevision}');
  `,
    ],
    { cwd: temporary, stdio: "pipe" },
  );
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
    /ti_org_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43}|ti_user_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43}|ag9_wak\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{32,}|ag9_uak_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{32,}/;
  for (const file of publishedFiles) {
    if (!file.isFile()) continue;
    const contents = await readFile(
      path.join(file.parentPath, file.name),
      "utf8",
    );
    assert.doesNotMatch(contents, credentialPattern);
  }
});
