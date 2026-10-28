import { BillingUsageStore } from "../src/billing/billing-usage-store";
import {
  buildMissingLlmRequestUsage,
  billingUsageReservation,
} from "../src/billing/billing-usage-fact";
import {
  buildWebSearchUsage,
  unpricedNonLlmValuation,
} from "../src/billing/non-llm-billing";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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

import { developmentReleaseServices } from "../test/support/ops-release-fixture";
import { AGENT_MODEL_NAMES } from "../src/agent-models/agent-model-registry";
import type { StreamFn, AssistantMessage } from "@earendil-works/pi-ai";

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
    throw new Error(
      "SDK Realtime verification does not redeem WebSocket credentials",
    );
  },
};

beforeAll(async () => {
  const releaseServices = developmentReleaseServices({
    models: [
      {
        provider: "openai_compatible",
        endpoint: "https://example.test/v1",
        apiMode: "responses",
        modelIds: AGENT_MODEL_NAMES,
        apiKey: "fictional-sdk-naming-key",
      },
    ],
  });
  const moduleRef = await createAppTestingModule({ releaseServices })
    .overrideProvider(ENV)
    .useValue(
      loadE2eEnv({
        NODE_ENV: "test",
        SCHEDULER_RUNNER: "1",
        SCHEDULER_POLL_INTERVAL_MS: "100",
        OPS_SERVICE_ALLOWED_HOSTS: "example.test",
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
  // Control only the external model transport; dispatch, Runtime and persistence stay real.
  const remote: StreamFn = async (model, context, options) => {
    const prompt = JSON.stringify(context.messages);
    const fail = prompt.includes("SDK_FIXTURE_FAIL");
    const pause = prompt.includes("SDK_FIXTURE_PAUSE");
    await options?.onResponse?.(
      {
        status: 200,
        headers: { "request-id": `fictional-sdk-${randomUUID()}` },
      },
      model,
    );
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        {
          type: "text",
          text: prompt.includes("SDK_FIXTURE")
            ? "SDK final answer."
            : "Trip planning",
        },
      ],
      stopReason: fail ? "error" : "stop",
      ...(fail ? { errorMessage: "Controlled SDK provider failure" } : {}),
      timestamp: 0,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } as AssistantMessage;
    return {
      async *[Symbol.asyncIterator]() {
        if (prompt.includes("SDK_FIXTURE_PROGRESS")) {
          yield {
            type: "start",
            partial: { ...message, content: [] },
          } as const;
          for (const text of ["SDK draft.", "SDK revised draft."]) {
            const partial = {
              ...message,
              content: [{ type: "text" as const, text }],
            };
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: text,
              partial,
            } as const;
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
        if (pause) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              options?.signal?.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(
              finish,
              prompt.includes("SDK_FIXTURE_OBSERVE_LONG") ? 7000 : 2000,
            );
            options?.signal?.addEventListener("abort", finish, { once: true });
            if (options?.signal?.aborted) finish();
          });
        }
        if (fail)
          yield { type: "error", reason: "error", error: message } as const;
        else yield { type: "done", reason: "stop", message } as const;
      },
      result: async () => message,
    } as unknown as Awaited<ReturnType<StreamFn>>;
  };
  vi.spyOn(
    getAppPersistencePorts(app).manualTitleConnections as unknown as {
      providerStream(): Promise<StreamFn>;
    },
    "providerStream",
  ).mockResolvedValue(remote);
  await app.listen(0, "127.0.0.1");
}, 120_000);

afterAll(async () => {
  await app?.close();
  vi.restoreAllMocks();
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

it("the packed SDK provisions users and manages Agents, Sessions and Realtime Connections through the selected service", async () => {
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
  const billing = app.get(BillingUsageStore);
  const usageAt = "2030-01-02T10:00:00.000Z";
  const billingTag = { key: "cost_center", value: "Café/QA" };
  const attribution = {
    organizationId: DEFAULT_ORG_ID,
    sessionId: "sdk_usage_session",
    turnId: "sdk_usage_turn",
    agentRunId: null,
    agentId: null,
    ownerUserId: owner.userId,
    authKind: "user-api-key" as const,
    principalBucket: "user_api_key" as const,
    billingTag,
  };
  const missingUsage = buildMissingLlmRequestUsage({
    llmRequestUsageId: "sdk_usage_unknown",
    requestPurpose: "agent_turn",
    attribution,
    provider: "openai",
    requestModel: "unknown-model",
    requestOutcome: "failed",
    unknownReason: "provider_usage_missing",
    createdAt: usageAt,
  });
  await billing.saveLlmRequestUsage(missingUsage);
  await billing.saveLlmRequestUsage({
    ...missingUsage,
    llmRequestUsageId: "sdk_usage_priced",
    requestModel: "gpt-5.4",
    model: "gpt-5.4",
    billingCredentialScope: "deployment",
    requestOutcome: "succeeded",
    usageEvidenceStatus: "complete",
    inputTokens: 100,
    promptTokensTotal: 100,
    uncachedInputTokens: 100,
    outputTokens: 20,
    inputCostMicros: 800,
    outputCostMicros: 200,
    costMicros: 1000,
    pricingStatus: "estimated",
    unknownReason: null,
    estimateBasis: "public_list_placeholder",
    estimateLabel: "public-list estimate",
    createdAt: "2030-01-02T11:00:00.000Z",
  });
  await billing.saveLlmRequestUsage({
    ...missingUsage,
    llmRequestUsageId: "sdk_usage_stale_cost",
    costMicros: 99000,
    createdAt: "2030-01-02T12:00:00.000Z",
  });
  await billing.saveLlmRequestUsage({
    ...missingUsage,
    llmRequestUsageId: "sdk_usage_other",
    ownerUserId: stranger.userId,
    billingCredentialScope: "deployment",
    promptTokensTotal: 0,
    costMicros: 3333,
    pricingStatus: "estimated",
    unknownReason: null,
  });
  await billing.saveLlmRequestUsage({
    ...missingUsage,
    llmRequestUsageId: "sdk_usage_untagged",
    billingTag: null,
    billingCredentialScope: "deployment",
    promptTokensTotal: 0,
    costMicros: 9000,
    pricingStatus: "estimated",
    unknownReason: null,
  });
  await billing.saveSandboxUsage({
    ...attribution,
    attributionKind: "user_level",
    sandboxUsageId: "sdk_usage_sandbox",
    provider: "e2b",
    sandboxId: "sdk_usage_sandbox_instance",
    profileId: "standard-v1",
    contractDigest: "a".repeat(64),
    artifactKind: "e2b_template",
    artifactIdentity: "sdk_usage_template",
    specKey: "sdk_usage_spec",
    startedAt: usageAt,
    lastSeenAt: usageAt,
    endedAt: null,
    durationSeconds: null,
    status: "running",
    closeReason: null,
    lastError: null,
    ...unpricedNonLlmValuation(usageAt),
    createdAt: usageAt,
    updatedAt: usageAt,
  });
  await billing.saveWebSearchUsage(
    buildWebSearchUsage({
      webSearchUsageId: "sdk_usage_search",
      operationId: "sdk_usage_search_operation",
      attribution,
      requestedResultCount: 3,
      returnedResultCount: null,
      submittedAt: usageAt,
      acceptedAt: usageAt,
      requestOutcome: "failed",
      usageEvidenceStatus: "missing",
      createdAt: usageAt,
    }),
  );
  const reserved = billingUsageReservation({
    usageId: "sdk_usage_unsettled",
    metadata: {
      kind: "llm",
      attribution,
      requestPurpose: "agent_turn",
      billingCredentialScope: "deployment",
      provider: "openai",
      requestModel: "gpt-5.4",
      reconciliation: "none",
    },
    createdAt: usageAt,
  });
  await billing.reserveBillingUsageIntent(reserved);
  await billing.markBillingUsageIntentSubmitted(reserved, usageAt);
  await billing.markBillingUsageIntentIndeterminate(
    reserved,
    usageAt,
    "controlled unknown supplier outcome",
  );

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
  const enabledSessionId = await createSession(
    ownerKey.token,
    enabledAgent.agentId,
  );
  const exampleSessionId = await createSession(
    ownerKey.token,
    enabledAgent.agentId,
  );
  const disabledSessionId = await createSession(
    ownerKey.token,
    disabledAgent.agentId,
  );

  const textSessionId = await createSession(
    ownerKey.token,
    enabledAgent.agentId,
  );
  await fixture.recordRealtimeExchange({
    organizationId: DEFAULT_ORG_ID,
    sessionId: textSessionId,
    voiceTurnId: `vt_${randomUUID().replaceAll("-", "")}`,
    createdAt: new Date("2026-10-27T00:00:00.000Z"),
    facts: [
      {
        type: "input_transcript",
        text: "Saved spoken question",
        turnId: null,
        startsTurn: false,
      },
      {
        type: "response",
        text: "Saved spoken answer",
        turnId: null,
        kind: "chat",
        responseId: "sdk_response",
        interrupted: true,
      },
    ],
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
    { cwd: temporary },
  );
  const serviceCases = JSON.parse(process.env.SDK_SERVICE_CASES!) as Array<{
    source: string;
    name: string;
  }>;
  await Promise.all(
    serviceCases.map(async ({ source, name }) => {
      const destination = path.join(temporary, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }),
  );
  try {
    const result = await exec(
      process.execPath,
      [
        "--test",
        "--test-concurrency=1",
        ...serviceCases.map(({ name }) => name),
      ],
      {
        cwd: temporary,
        env: {
          ...process.env,
          SDK_SERVICE_URL: await app.getUrl(),
          SDK_ORGANIZATION_KEY: own.token,
          SDK_FOREIGN_ORGANIZATION_KEY: foreign.token,
          SDK_USER_KEY: ownerKey.token,
          SDK_USAGE_USER_ID: owner.userId,
          SDK_USAGE_STRANGER_ID: stranger.userId,
          SDK_TEXT_SESSION_ID: textSessionId,
          SDK_FOREIGN_USER_KEY: strangerKey.token,
          SDK_REALTIME_SESSION_ID: enabledSessionId,
          SDK_TEMPLATE_ID: enabledTemplateId,
          SDK_OTHER_TEMPLATE_ID: disabledTemplateId,
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
