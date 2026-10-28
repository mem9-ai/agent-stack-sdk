import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  createAppTestingModule,
  AppTestingPersistenceFixture,
  getAppPersistencePorts,
} from "../test/support/app-testing-module";
import { loadE2eEnv } from "../test/support/e2e-env";
import { developmentReleaseServices } from "../test/support/ops-release-fixture";
import { createPublishedFixtureAgent } from "../test/support/published-agent-creation";
import {
  ControlledIntegrationProvider,
  CONTROLLED_INTEGRATION_VALUES,
} from "../test/system/support/controlled-integration-provider";
import { createAgentServiceFastifyAdapter } from "../src/common/fastify-adapter";
import { ENV } from "../src/config/config.module";
import {
  AGENT_RUNTIME_CONFIG,
  agentRuntimeConfigFromEnv,
  PI_AGENT_RUNTIME_CONFIG,
  piAgentRuntimeConfigFromEnv,
} from "../src/config/runtime-config";
import { AGENT_MODEL_NAMES } from "../src/agent-models/agent-model-registry";
import { UserApiKeyService } from "../src/auth/user-api-key.service";
import { DEFAULT_ORG_ID } from "../src/chat/dto";
import { CHECKPOINT_FS_PORT } from "../src/checkpoint/checkpoint-port";
import { Drive9CheckpointFsPort } from "../src/checkpoint/drive9-checkpoint-fs.port";
import type { Drive9SessionDriveProvisioner } from "../src/drive/drive9-session-drive-provisioner";
import type { DriveLifecycle } from "../src/drive/drive-session";
import { ScriptedModelProvider } from "../test/system/support/scripted-model-provider";

const exec = promisify(execFile);
let app: NestFastifyApplication;
let supplier: ControlledIntegrationProvider;
let modelProvider: ScriptedModelProvider;
let temporary: string;

beforeAll(async () => {
  supplier = await ControlledIntegrationProvider.start();
  modelProvider = await ScriptedModelProvider.start({ model: "gpt-5.6-luna" });
  const provisioner = {
    provider: () => "drive9",
    ensureDriveForSession: async (scope: {
      organizationId: string;
      sessionId: string;
    }) => ({
      ...scope,
      provider: "drive9",
      resourceId: "controlled-drive9-tenant",
      remoteMode: "session_scoped",
      remoteHint: `:/tidb-link/sessions/${scope.sessionId}/`,
      status: "ready",
      lastError: null,
    }),
    withSessionOwnerWriteKey: async (
      _scope: unknown,
      _job: string,
      use: (server: string, key: string) => Promise<unknown>,
    ) => use(supplier.baseUrl, CONTROLLED_INTEGRATION_VALUES.drive9OwnerKey),
  } as unknown as Drive9SessionDriveProvisioner;
  const checkpoint = new Drive9CheckpointFsPort(provisioner, {
    drainTurn: async () => undefined,
  } as unknown as DriveLifecycle);
  const env = loadE2eEnv({
    NODE_ENV: "test",
    TURN_CHECKPOINT_ENABLED: "1",
    OPS_SERVICE_ALLOWED_HOSTS: "example.test,127.0.0.1",
    WORKSPACE_KEK: "fictional-sdk-retry-kek",
    SESSION_SECRET: "fictional-sdk-retry-session",
  });
  const releaseServices = {
    ...developmentReleaseServices({
      models: [
        {
          provider: "openai_compatible",
          endpoint: modelProvider.openAi.baseUrl,
          apiMode: "chat_completions",
          modelIds: AGENT_MODEL_NAMES,
          apiKey: modelProvider.openAi.apiKey,
        },
      ],
    }),
    sandbox: { provider: "e2b" as const, apiKey: "fictional-sdk-sandbox-key" },
    drive9: {
      server: "https://api.drive9.ai",
      provisionMode: "anonymous" as const,
    },
  };
  const moduleRef = await createAppTestingModule({ releaseServices })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AGENT_RUNTIME_CONFIG)
    .useValue(agentRuntimeConfigFromEnv(env))
    .overrideProvider(PI_AGENT_RUNTIME_CONFIG)
    .useValue(piAgentRuntimeConfigFromEnv(env))
    .overrideProvider(CHECKPOINT_FS_PORT)
    .useValue(checkpoint)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAgentServiceFastifyAdapter(),
  );
  await app.init();
  await expect(
    app.get(AppTestingPersistenceFixture).hasActiveServiceRelease(),
  ).resolves.toBe(true);
  await app.listen(0, "127.0.0.1");
}, 120000);

afterAll(async () => {
  await app?.close();
  await supplier?.stop();
  await modelProvider?.stop();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("the installed SDK explicitly retries through enabled checkpoint admission and preserves original outcomes", async () => {
  const paused = modelProvider.enqueueText({
    chunks: ["Discarded draft."],
    pauseBeforeResponse: true,
  });
  const resumed = modelProvider.enqueueText({
    chunks: ["Retried task ", "completed."],
    pauseAfterChunk: 0,
  });
  const fixture = app.get(AppTestingPersistenceFixture);
  const owner = await fixture.arrangeEndUser({
    organizationId: DEFAULT_ORG_ID,
    displayName: "SDK retry owner",
  });
  const key = await app.get(UserApiKeyService).create({
    organizationId: DEFAULT_ORG_ID,
    userId: owner.userId,
    name: "SDK retry",
  });
  const agent = await createPublishedFixtureAgent(
    getAppPersistencePorts(app).agentStore,
    { organizationId: DEFAULT_ORG_ID, userId: owner.userId },
  );
  temporary = await mkdtemp(path.join(tmpdir(), "sdk-retry-consumer-"));
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
  const cases = JSON.parse(process.env.SDK_SERVICE_CASES!) as Array<{
    source: string;
    name: string;
  }>;
  for (const { source, name } of cases) {
    await mkdir(path.dirname(path.join(temporary, name)), { recursive: true });
    await copyFile(source, path.join(temporary, name));
  }
  const pausedFile = path.join(temporary, "supplier-paused");
  const observedDraftFile = path.join(temporary, "retry-draft-observed");
  const resumeAfterObservation = (async () => {
    await resumed.waitUntilPaused(15000);
    const deadline = Date.now() + 10000;
    try {
      while (true) {
        try {
          await access(observedDraftFile);
          return;
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "ENOENT" ||
            Date.now() >= deadline
          )
            throw error;
        }
        await setTimeout(20);
      }
    } finally {
      resumed.release();
    }
  })();
  void resumeAfterObservation.catch(() => undefined);
  const supplierReady = paused
    .waitUntilPaused(15000)
    .then(() => writeFile(pausedFile, "ready"));
  void supplierReady.catch(() => undefined);
  try {
    const result = await exec(
      process.execPath,
      ["--test", "--test-concurrency=1", ...cases.map(({ name }) => name)],
      {
        cwd: temporary,
        env: {
          ...process.env,
          SDK_SERVICE_URL: await app.getUrl(),
          SDK_USER_KEY: key.token,
          SDK_RETRY_AGENT_ID: agent.agentId,
          SDK_RETRY_PAUSED_FILE: pausedFile,
          SDK_RETRY_OBSERVED_DRAFT_FILE: observedDraftFile,
        },
      },
    );
    await supplierReady;
    await resumeAfterObservation;
    console.log(result.stdout);
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Packed SDK retry verification failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`,
    );
  } finally {
    paused.release();
    resumed.release();
  }
}, 120000);
