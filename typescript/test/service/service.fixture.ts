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
  getAppPersistencePorts,
} from "../test/support/app-testing-module";
import { createPublishedFixtureAgent } from "../test/support/published-agent-creation";
import { loadE2eEnv } from "../test/support/e2e-env";
import { OrganizationApiKeyService } from "../src/auth/organization-api-key.service";
import { UserApiKeyService } from "../src/auth/user-api-key.service";
import { AgentTemplateContentSchema } from "../src/agent-templates/agent-template-content";
import { createAgentServiceFastifyAdapter } from "../src/common/fastify-adapter";
import { ENV } from "../src/config/config.module";
import { DEFAULT_ORG_ID } from "../src/chat/dto";
import { OrganizationStore } from "../src/organizations/organization-store";
import { OpsRealtimeModelSource } from "../src/ops/ops-realtime-model-source";

const exec = promisify(execFile);
let app: NestFastifyApplication;
let temporary: string;

const realtimeSettings = (model: string) => ({
  provider: "bailian_qwen_omni" as const,
  region: "cn-beijing" as const,
  workspaceId: "fictional-sdk-workspace",
  model,
  voice: null,
  turnDetection: null,
  vadThreshold: null,
  vadSilenceDurationMs: null,
});
const realtimeModels = [
  {
    id: "voice-a",
    label: "Voice A",
    settings: realtimeSettings("provider-a"),
    available: true,
  },
  {
    id: "voice-b",
    label: "Voice B",
    settings: realtimeSettings("provider-b"),
    available: true,
  },
  {
    id: "voice-unavailable",
    label: "Unavailable voice",
    settings: realtimeSettings("provider-unavailable"),
    available: false,
  },
];
const realtimeSource = {
  list: async () => ({ models: realtimeModels, defaultModelId: "voice-a" }),
  current: async () => realtimeModels[0].settings,
  readiness: async () => "configured" as const,
  open: async () => {
    throw new Error("SDK Realtime verification does not redeem WebSocket credentials");
  },
};

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
    .overrideProvider(OpsRealtimeModelSource)
    .useValue(realtimeSource)
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

const createSession = async (token: string, agentId: string) => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/user/sessions",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": randomUUID(),
    },
    payload: { agentId },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().session.sessionId as string;
};

it("the packed SDK provisions users and prepares Realtime Connections through the selected service", async () => {
  const store = app.get(OrganizationStore);
  const foreignOrganizationId = `org_sdk_${randomUUID().replaceAll("-", "")}`;
  await store.seedOrganization({
    organizationId: foreignOrganizationId,
    slug: foreignOrganizationId,
    name: "SDK foreign Organization",
  });
  const organizationKeys = app.get(OrganizationApiKeyService);
  const own = await organizationKeys.create({
    organizationId: DEFAULT_ORG_ID,
    name: "SDK provisioning fixture",
    createdByUserId: null,
  });
  const foreign = await organizationKeys.create({
    organizationId: foreignOrganizationId,
    name: "SDK foreign fixture",
    createdByUserId: null,
  });

  const fixture = app.get(AppTestingPersistenceFixture);
  const owner = await fixture.arrangeEndUser({
    organizationId: DEFAULT_ORG_ID,
    displayName: "SDK Realtime owner",
  });
  const stranger = await fixture.arrangeEndUser({
    organizationId: DEFAULT_ORG_ID,
    displayName: "SDK Realtime stranger",
  });
  const userKeys = app.get(UserApiKeyService);
  const ownerKey = await userKeys.create({
    organizationId: DEFAULT_ORG_ID,
    userId: owner.userId,
    name: "SDK Realtime owner",
  });
  const strangerKey = await userKeys.create({
    organizationId: DEFAULT_ORG_ID,
    userId: stranger.userId,
    name: "SDK Realtime stranger",
  });
  const ports = getAppPersistencePorts(app);
  const enabledTemplateId = `template_${randomUUID().replaceAll("-", "")}`;
  await ports.agentStore.createAgentTemplate({
    organizationId: DEFAULT_ORG_ID,
    agentTemplateId: enabledTemplateId,
    name: "SDK Realtime enabled",
  });
  await fixture.arrangeAgentTemplateContent({
    organizationId: DEFAULT_ORG_ID,
    templateId: enabledTemplateId,
    content: AgentTemplateContentSchema.parse({
      realtime: { language: "en-US" },
      identity: { agentName: "SDK Realtime enabled" },
      sandbox: { profileId: "standard-v1" },
    }),
  });
  const enabledAgent = await createPublishedFixtureAgent(ports.agentStore, {
    organizationId: DEFAULT_ORG_ID,
    userId: owner.userId,
    agentTemplateId: enabledTemplateId,
  });
  const disabledTemplateId = `template_${randomUUID().replaceAll("-", "")}`;
  await ports.agentStore.createAgentTemplate({
    organizationId: DEFAULT_ORG_ID,
    agentTemplateId: disabledTemplateId,
    name: "SDK Realtime disabled",
  });
  await fixture.arrangeAgentTemplateContent({
    organizationId: DEFAULT_ORG_ID,
    templateId: disabledTemplateId,
    content: AgentTemplateContentSchema.parse({
      realtime: null,
      identity: { agentName: "SDK Realtime disabled" },
      sandbox: { profileId: "standard-v1" },
    }),
  });
  const disabledAgent = await createPublishedFixtureAgent(ports.agentStore, {
    organizationId: DEFAULT_ORG_ID,
    userId: owner.userId,
    agentTemplateId: disabledTemplateId,
  });
  const enabledSessionId = await createSession(ownerKey.token, enabledAgent.agentId);
  const exampleSessionId = await createSession(ownerKey.token, enabledAgent.agentId);
  const disabledSessionId = await createSession(ownerKey.token, disabledAgent.agentId);

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
    { cwd: temporary },
  );
  const serviceCases = JSON.parse(process.env.SDK_SERVICE_CASES!) as string[];
  const installedCaseNames = serviceCases.map((source) => path.basename(source));
  await Promise.all(
    serviceCases.map((source, index) =>
      copyFile(source, path.join(temporary, installedCaseNames[index]!)),
    ),
  );
  try {
    const result = await exec(
      process.execPath,
      ["--test", "--test-concurrency=1", ...installedCaseNames],
      {
        cwd: temporary,
        env: {
          ...process.env,
          SDK_SERVICE_URL: await app.getUrl(),
          SDK_ORGANIZATION_KEY: own.token,
          SDK_FOREIGN_ORGANIZATION_KEY: foreign.token,
          SDK_USER_KEY: ownerKey.token,
          SDK_FOREIGN_USER_KEY: strangerKey.token,
          SDK_REALTIME_SESSION_ID: enabledSessionId,
          SDK_REALTIME_EXAMPLE_SESSION_ID: exampleSessionId,
          SDK_REALTIME_DISABLED_SESSION_ID: disabledSessionId,
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
