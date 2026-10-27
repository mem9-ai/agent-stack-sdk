import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  AppTestingPersistenceFixture,
  createAppTestingModule,
} from "../test/support/app-testing-module";
import { loadE2eEnv } from "../test/support/e2e-env";
import { OrganizationApiKeyService } from "../src/auth/organization-api-key.service";
import { createAgentServiceFastifyAdapter } from "../src/common/fastify-adapter";
import { ENV } from "../src/config/config.module";
import { DEFAULT_ORG_ID } from "../src/chat/dto";
import { OrganizationStore } from "../src/organizations/organization-store";

const exec = promisify(execFile);
let app: NestFastifyApplication;
let temporary: string;

beforeAll(async () => {
  const moduleRef = await createAppTestingModule()
    .overrideProvider(ENV)
    .useValue(
      loadE2eEnv({
        NODE_ENV: "test",
        WORKSPACE_KEK: "fictional-sdk-service-test-kek",
        SESSION_SECRET: "fictional-sdk-service-session-secret",
      }),
    )
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAgentServiceFastifyAdapter(),
  );
  await app.init();
  await expect(
    app.get(AppTestingPersistenceFixture).hasActiveServiceRelease(),
  ).resolves.toBe(true);
  await app.listen(0, "127.0.0.1");
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("the packed SDK provisions End Users and manages credentials through the selected service", async () => {
  const store = app.get(OrganizationStore);
  const foreignOrganizationId = `org_sdk_${randomUUID().replaceAll("-", "")}`;
  await store.seedOrganization({
    organizationId: foreignOrganizationId,
    slug: foreignOrganizationId,
    name: "SDK foreign Organization",
  });
  const keys = app.get(OrganizationApiKeyService);
  const own = await keys.create({
    organizationId: DEFAULT_ORG_ID,
    name: "SDK provisioning fixture",
    createdByUserId: null,
  });
  const foreign = await keys.create({
    organizationId: foreignOrganizationId,
    name: "SDK foreign fixture",
    createdByUserId: null,
  });
  temporary = await mkdtemp(path.join(tmpdir(), "agent-stack-sdk-service-"));
  const packed = JSON.parse(
    (
      await exec("npm", ["pack", "--json", "--pack-destination", temporary], {
        cwd: process.env.SDK_PACKAGE_ROOT,
      })
    ).stdout,
  )[0];
  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(temporary, packed.filename),
    ],
    {
      cwd: temporary,
    },
  );
  await copyFile(
    process.env.SDK_SERVICE_CASES!,
    path.join(temporary, "provisioning.cases.mjs"),
  );
  try {
    const result = await exec(
      process.execPath,
      ["--test", "provisioning.cases.mjs"],
      {
        cwd: temporary,
        env: {
          ...process.env,
          SDK_SERVICE_URL: await app.getUrl(),
          SDK_ORGANIZATION_KEY: own.token,
          SDK_FOREIGN_ORGANIZATION_KEY: foreign.token,
        },
      },
    );
    console.log(result.stdout);
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Packed SDK service verification failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`,
    );
  }
}, 120_000);
