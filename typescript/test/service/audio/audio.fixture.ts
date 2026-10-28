import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
import { loadE2eEnv } from "../test/support/e2e-env";
import { UserApiKeyService } from "../src/auth/user-api-key.service";
import { AgentTemplateContentSchema } from "../src/agent-templates/agent-template-content";
import { createAgentServiceFastifyAdapter } from "../src/common/fastify-adapter";
import { ENV } from "../src/config/config.module";
import { DEFAULT_ORG_ID } from "../src/chat/dto";
import { BillingUsageStore } from "../src/billing/billing-usage-store";
import { developmentReleaseServices } from "../test/support/ops-release-fixture";
import { AGENT_MODEL_NAMES } from "../src/agent-models/agent-model-registry";
import type { StreamFn, AssistantMessage } from "@earendil-works/pi-ai";

const exec = promisify(execFile);
let app: NestFastifyApplication;
let temporary: string;
let asrUrl: string;
const transcribed: string[] = [];
// The real transcription adapter sends multipart audio to this controlled supplier.
const asr = createServer(async (req, res) => {
  try {
    expect(req.url).toBe("/v1/audio/transcriptions");
    expect(req.headers.authorization).toBe("Bearer fictional-sdk-asr-key");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = await new Response(Buffer.concat(chunks), {
      headers: { "content-type": req.headers["content-type"]! },
    }).formData();
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file") as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    transcribed.push(file.name);
    if (
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE"
    ) {
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "malformed audio" }));
      return;
    }
    if (file.name === "provider-refused.wav") {
      res
        .writeHead(503, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "supplier unavailable" }));
      return;
    }
    const text =
      file.name === "paused.wav"
        ? "SDK_FIXTURE_PAUSE audio"
        : file.name === "model-fail.wav"
          ? "SDK_FIXTURE_FAIL audio"
          : "SDK_FIXTURE_AUDIO transcribed speech";
    res
      .writeHead(200, {
        "content-type": "application/json",
        "x-request-id": `asr-${randomUUID()}`,
      })
      .end(JSON.stringify({ text, duration: 0.01 }));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "sdk-audio-service-"));
  await new Promise<void>((resolve) => asr.listen(0, "127.0.0.1", resolve));
  const address = asr.address();
  if (!address || typeof address === "string")
    throw new Error("ASR supplier did not listen");
  asrUrl = `http://127.0.0.1:${address.port}`;
  const releaseServices = developmentReleaseServices({
    models: [
      {
        provider: "openai_compatible",
        endpoint: "https://example.test/v1",
        apiMode: "responses",
        modelIds: AGENT_MODEL_NAMES,
        apiKey: "fictional-sdk-audio-model",
      },
    ],
  });
  const moduleRef = await createAppTestingModule({ releaseServices })
    .overrideProvider(ENV)
    .useValue(
      loadE2eEnv({
        NODE_ENV: "test",
        OPS_SERVICE_ALLOWED_HOSTS: "example.test",
        WORKSPACE_KEK: "fictional-sdk-audio-kek",
        SESSION_SECRET: "fictional-sdk-audio-session",
        ASR_OPENAI_API_KEY: "fictional-sdk-asr-key",
        ASR_OPENAI_BASE_URL: `${asrUrl}/v1`,
      }),
    )
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAgentServiceFastifyAdapter(),
  );
  await app.init();
  const remote: StreamFn = async (model, context, options) => {
    const prompt = JSON.stringify(context.messages);
    const fail = prompt.includes("SDK_FIXTURE_FAIL");
    const pause = prompt.includes("SDK_FIXTURE_PAUSE");
    await options?.onResponse?.(
      { status: 200, headers: { "request-id": randomUUID() } },
      model,
    );
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Audio final answer." }],
      stopReason: fail ? "error" : "stop",
      ...(fail ? { errorMessage: "Controlled audio model failure" } : {}),
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
        if (pause)
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              options?.signal?.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 2000);
            options?.signal?.addEventListener("abort", finish, { once: true });
            if (options?.signal?.aborted) finish();
          });
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
}, 120000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => asr.close(() => resolve()));
  vi.restoreAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("the installed SDK submits actual audio through transcription, budget and Runtime boundaries", async () => {
  const fixture = app.get(AppTestingPersistenceFixture);
  const keys = app.get(UserApiKeyService);
  const users = await Promise.all(
    ["owner", "stranger", "budget"].map(async (displayName) => {
      const user = await fixture.arrangeEndUser({
        organizationId: DEFAULT_ORG_ID,
        displayName,
      });
      const key = await keys.create({
        organizationId: DEFAULT_ORG_ID,
        userId: user.userId,
        name: "SDK Audio",
      });
      return { ...user, token: key.token };
    }),
  );
  const [owner, stranger, budget] = users;
  const limited = await app
    .get(BillingUsageStore)
    .mutateLlmSpendLimit({
      organizationId: DEFAULT_ORG_ID,
      scope: { kind: "member", userId: budget!.userId },
      expectedRevision: 0,
      monthlyBaseMicros: 0,
      actorUserId: owner!.userId,
    });
  expect(limited?.availableMicros).toBe(0);
  const templateId = `template_${randomUUID().replaceAll("-", "")}`;
  await getAppPersistencePorts(app).agentStore.createAgentTemplate({
    organizationId: DEFAULT_ORG_ID,
    agentTemplateId: templateId,
    name: "SDK Audio",
  });
  await fixture.arrangeAgentTemplateContent({
    organizationId: DEFAULT_ORG_ID,
    templateId,
    content: AgentTemplateContentSchema.parse({
      realtime: null,
      identity: { agentName: "SDK Audio" },
      sandbox: { profileId: "standard-v1" },
    }),
  });
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  const packed = JSON.parse(
    (
      await exec("npm", ["pack", "--json", "--pack-destination", consumer], {
        cwd: process.env.SDK_PACKAGE_ROOT,
      })
    ).stdout,
  )[0];
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(consumer, packed.filename),
    ],
    { cwd: consumer },
  );
  const cases = JSON.parse(process.env.SDK_SERVICE_CASES!) as Array<{
    source: string;
    name: string;
  }>;
  for (const entry of cases) {
    const destination = path.join(consumer, entry.name);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(entry.source, destination);
  }
  try {
    const result = await exec(
      process.execPath,
      ["--test", "--test-concurrency=1", ...cases.map((entry) => entry.name)],
      {
        cwd: consumer,
        env: {
          ...process.env,
          SDK_SERVICE_URL: await app.getUrl(),
          SDK_USER_KEY: owner!.token,
          SDK_FOREIGN_USER_KEY: stranger!.token,
          SDK_AUDIO_BUDGET_USER_KEY: budget!.token,
          SDK_TEMPLATE_ID: templateId,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    console.log(result.stdout);
    expect(transcribed).not.toContain("budget.wav");
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `SDK audio service cases failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`,
    );
  }
}, 120000);
