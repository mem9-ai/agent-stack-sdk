import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

assert.match(
  process.version,
  /^v26\./,
  "The selected Agent Service requires Node.js 26",
);
assert(
  process.env.AGENT_SERVICE_ROOT,
  "Set AGENT_SERVICE_ROOT to the selected service checkout",
);
assert(
  process.env.TEST_TIDB_DATABASE_URL,
  "Set TEST_TIDB_DATABASE_URL to a dedicated test database",
);
assert(
  !process.env.DATABASE_URL ||
    process.env.DATABASE_URL === process.env.TEST_TIDB_DATABASE_URL,
  "DATABASE_URL and TEST_TIDB_DATABASE_URL must select the same dedicated test database",
);
const serviceRoot = await realpath(process.env.AGENT_SERVICE_ROOT);
const manifest = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: serviceRoot,
  encoding: "utf8",
}).trim();
assert.equal(
  revision,
  manifest.tidbLinkRevision,
  "Agent Service revision does not match the SDK baseline",
);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], {
    cwd: serviceRoot,
    encoding: "utf8",
  }).trim(),
  "",
  "Agent Service checkout must be clean for exact-baseline verification",
);
const openapi = await readFile(path.join(serviceRoot, "docs/openapi.yaml"));
const openApiSha256 = createHash("sha256").update(openapi).digest("hex");
assert.equal(
  openApiSha256,
  manifest.tidbLinkOpenApiSha256,
  "Agent Service OpenAPI does not match the SDK baseline",
);
const serviceCaseDirectory = fileURLToPath(new URL(".", import.meta.url));
const entries = await readdir(serviceCaseDirectory, { recursive: true });
const fixtures = entries.filter((name) => name.endsWith(".fixture.ts")).sort();
assert(fixtures.length > 0, "No SDK service fixtures were discovered");
const fixtureDirectories = fixtures.map((name) => path.dirname(name));
assert.equal(
  new Set(fixtureDirectories).size,
  fixtures.length,
  "Only one service fixture may own each case directory",
);
for (const name of entries.filter((name) => name.endsWith(".cases.mjs")))
  assert(
    fixtureDirectories.includes(path.dirname(name)),
    `No neighboring service fixture owns ${name}`,
  );

await mkdir(path.join(serviceRoot, ".agent9"), { recursive: true });
// Each fixture owns a distinct dependency lifecycle and its neighboring cases.
for (const fixtureName of fixtures) {
  const serviceCases = entries
    .filter(
      (name) =>
        name.endsWith(".cases.mjs") &&
        path.dirname(name) === path.dirname(fixtureName),
    )
    .sort()
    .map((name) => ({ source: path.join(serviceCaseDirectory, name), name }));
  assert(serviceCases.length > 0, `No SDK service cases for ${fixtureName}`);
  const temporary = await mkdtemp(
    path.join(serviceRoot, ".agent9", "sdk-service-"),
  );
  try {
    await writeFile(
      path.join(temporary, "sdk.e2e-spec.ts"),
      (await readFile(path.join(serviceCaseDirectory, fixtureName), "utf8"))
        .replaceAll('"../test/', '"../../test/')
        .replaceAll('"../src/', '"../../src/'),
    );
    const config = path.join(temporary, "vitest.config.mjs");
    await writeFile(
      config,
      `import base from "../../vitest.config.ts";\nexport default { ...base, test: { ...base.test, include: [${JSON.stringify(path.relative(serviceRoot, path.join(temporary, "sdk.e2e-spec.ts")))}] } };\n`,
    );
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["node_modules/vitest/vitest.mjs", "run", "--config", config],
        {
          cwd: serviceRoot,
          stdio: "inherit",
          env: {
            ...process.env,
            DATABASE_URL: process.env.TEST_TIDB_DATABASE_URL,
            CUSTOMER_HTTP_EVIDENCE_PATH: path.join(
              temporary,
              "customer-http-outcomes.json",
            ),
            SDK_PACKAGE_ROOT: fileURLToPath(new URL("../..", import.meta.url)),
            SDK_SERVICE_CASES: JSON.stringify(serviceCases),
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      break;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
