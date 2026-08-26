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
  const temporary = await mkdtemp(path.join(tmpdir(), "agent-stack-sdk-consumer-"));
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
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: temporary,
    stdio: "pipe",
  });

  await writeFile(
    path.join(temporary, "consumer.ts"),
    `import type {
      Agent,
      AgentConfigPatch,
      ProjectRecord,
      PublicAgentConfig,
      ServiceUser,
      Session,
      TurnResult,
    } from "@mem9/agent-stack";
    import {
      listProjects,
      UserClient,
      WorkspaceClient,
    } from "@mem9/agent-stack";

    declare const baseUrl: string;
    declare const workspaceApiKey: string;
    const workspace = new WorkspaceClient({ baseUrl, apiKey: workspaceApiKey });
    const serviceUser: ServiceUser = workspace.serviceUser("user_1");
    type CodexRuntime = Extract<PublicAgentConfig["runtime"], { backend: "codex" }>;
    const effort: CodexRuntime["modelReasoningEffort"] = "high";
    async function quickStart(): Promise<TurnResult> {
      const created: ServiceUser = await workspace.createServiceUser({ displayName: "Customer" });
      const { token } = await created.createApiKey({ name: "backend" });
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
    void effort; void serviceUser; void quickStart;
    `,
  );
  const tsc = path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
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

  const installedRoot = path.join(temporary, "node_modules", "@mem9", "agent-stack");
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.agentServiceApiVersion, "0.0.1");
  assert.match(installedPackage.version, /^0\./);
  assert.deepEqual((await readdir(installedRoot)).sort(), ["LICENSE", "README.md", "dist", "package.json"]);

  const publishedFiles = await readdir(installedRoot, { recursive: true, withFileTypes: true });
  const credentialPattern = /ag9_wak\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{32,}|ag9_uak_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{32,}/;
  for (const file of publishedFiles) {
    if (!file.isFile()) continue;
    const contents = await readFile(path.join(file.parentPath, file.name), "utf8");
    assert.doesNotMatch(contents, credentialPattern);
  }
});
