import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
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
import { Drive9CredentialResolver } from "../src/drive/drive9-credential-resolver";
import { TestFixtureDrive9CredentialResolver } from "../test/drive9-secret-test-helper";
import { developmentReleaseServices } from "../test/support/ops-release-fixture";
import { AGENT_MODEL_NAMES } from "../src/agent-models/agent-model-registry";
import type { StreamFn, AssistantMessage } from "@earendil-works/pi-ai";

const exec = promisify(execFile);
let app: NestFastifyApplication;
let temporary: string;
let supplierUrl: string;
const uploads = new Map<
  string,
  {
    filePath: string;
    size: number;
    parts: Map<number, Buffer>;
    checksums: Map<number, string>;
  }
>();
const stored = new Map<string, Buffer>();
const json = (res: ServerResponse, value: unknown, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));
// This is only the external Drive9/S3 byte supplier; all upload admission and verification stay real.
const supplier = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, supplierUrl);
    const pathname = decodeURIComponent(url.pathname);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (pathname.startsWith("/signed/")) {
      expect(req.headers.authorization).toBeUndefined();
      const [, , id, numberValue] = pathname.split("/");
      const upload = uploads.get(id!)!;
      const number = Number(numberValue);
      expect(createHash("sha256").update(bytes).digest("base64")).toBe(
        upload.checksums.get(number),
      );
      expect(req.headers["x-amz-checksum-sha256"]).toBe(
        upload.checksums.get(number),
      );
      upload.parts.set(number, bytes);
      res.writeHead(200, { etag: `"part-${number}"` }).end();
      return;
    }
    if (pathname === "/v1/status") {
      json(res, { inline_threshold: 5, max_upload_bytes: 200 * 1024 * 1024 });
      return;
    }
    if (url.searchParams.has("mkdir")) {
      json(res, {});
      return;
    }
    if (pathname === "/v2/uploads/initiate") {
      const body = JSON.parse(bytes.toString());
      const id = randomUUID();
      uploads.set(id, {
        filePath: body.path,
        size: body.total_size,
        parts: new Map(),
        checksums: new Map(),
      });
      json(
        res,
        {
          upload_id: id,
          part_size: 8,
          total_parts: Math.ceil(body.total_size / 8),
          expires_at: new Date(Date.now() + 600000).toISOString(),
          checksum_contract: { supported: ["SHA-256"], required: true },
        },
        202,
      );
      return;
    }
    const command = /^\/v2\/uploads\/([^/]+)\/(presign|complete|abort)$/.exec(
      pathname,
    );
    if (command) {
      const upload = uploads.get(command[1]!)!;
      const body = JSON.parse(bytes.toString() || "{}");
      if (command[2] === "presign") {
        const number = body.part_number;
        upload.checksums.set(number, body.checksum.value);
        json(res, {
          number,
          url: `${supplierUrl}/signed/${command[1]}/${number}`,
          size: Math.min(8, upload.size - (number - 1) * 8),
          checksum_sha256: body.checksum.value,
          headers: { "x-amz-checksum-sha256": body.checksum.value },
          expires_at: new Date(Date.now() + 60000).toISOString(),
        });
      } else if (command[2] === "complete") {
        const complete = Buffer.concat(
          body.parts.map((part: { number: number; etag: string }) => {
            expect(part.etag).toBe(`"part-${part.number}"`);
            return upload.parts.get(part.number)!;
          }),
        );
        if (upload.filePath.endsWith("/corrupt.txt"))
          complete[0] = complete[0]! ^ 1;
        stored.set(upload.filePath, complete);
        json(res, { status: "completed" });
      } else {
        uploads.delete(command[1]!);
        json(res, { status: "aborted" });
      }
      return;
    }
    if (pathname.startsWith("/v1/fs/")) {
      const filePath = "/" + pathname.slice("/v1/fs/".length);
      const content = stored.get(filePath);
      if (url.searchParams.has("stat")) {
        if (content) json(res, { isdir: false, size: content.length });
        else if (filePath.endsWith("/")) json(res, { isdir: true });
        else json(res, {}, 404);
      } else if (content)
        res
          .writeHead(200, { "content-length": String(content.length) })
          .end(content);
      else json(res, {}, 404);
      return;
    }
    json(res, {}, 404);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

beforeAll(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "sdk-files-service-"));
  await new Promise<void>((resolve) =>
    supplier.listen(0, "127.0.0.1", resolve),
  );
  const address = supplier.address();
  if (!address || typeof address === "string")
    throw new Error("supplier did not listen");
  supplierUrl = `http://127.0.0.1:${address.port}`;
  const releaseServices = developmentReleaseServices({
    models: [
      {
        provider: "openai_compatible",
        endpoint: "https://example.test/v1",
        apiMode: "responses",
        modelIds: AGENT_MODEL_NAMES,
        apiKey: "fictional-files-model-key",
      },
    ],
  });
  const moduleRef = await createAppTestingModule({ releaseServices })
    .overrideProvider(ENV)
    .useValue(
      loadE2eEnv({
        NODE_ENV: "test",
        OPS_SERVICE_ALLOWED_HOSTS: "example.test",
        WORKSPACE_ROOT: path.join(temporary, "workspace"),
        WORKSPACE_KEK: "fictional-files-kek",
        SESSION_SECRET: "fictional-files-session",
        TIDB_LINK_TEST_LOCAL_DRIVE_CAPABILITY: "1",
      }),
    )
    .overrideProvider(Drive9CredentialResolver)
    .useValue(new TestFixtureDrive9CredentialResolver())
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAgentServiceFastifyAdapter(),
  );
  await app.init();
  const remote: StreamFn = async (model, context, options) => {
    await options?.onResponse?.(
      { status: 200, headers: { "request-id": randomUUID() } },
      model,
    );
    const toolResult = context.messages.findLast(
      (message) => message.role === "toolResult",
    );
    const selectedPath = JSON.stringify(context.messages).match(
      /\/home\/user\/uploads\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+/,
    )?.[0];
    const content: AssistantMessage["content"] = toolResult
      ? [{ type: "text", text: JSON.stringify(toolResult.content) }]
      : selectedPath
        ? [
            {
              type: "toolCall",
              id: "sdk_read_selected",
              name: "read_file",
              arguments: { path: selectedPath },
            },
          ]
        : [{ type: "text", text: "No file selected." }];
    const message = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content,
      stopReason: toolResult || !selectedPath ? "stop" : "toolUse",
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
        yield { type: "done", reason: message.stopReason, message };
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
  await new Promise<void>((resolve) => supplier.close(() => resolve()));
  vi.restoreAllMocks();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

it("the installed SDK uploads and reads files through actual service authority, persistence and Runtime", async () => {
  const fixture = app.get(AppTestingPersistenceFixture);
  const ports = getAppPersistencePorts(app);
  const keys = app.get(UserApiKeyService);
  const users = await Promise.all(
    ["local", "stranger", "remote"].map(async (displayName) => {
      const user = await fixture.arrangeEndUser({
        organizationId: DEFAULT_ORG_ID,
        displayName,
      });
      const key = await keys.create({
        organizationId: DEFAULT_ORG_ID,
        userId: user.userId,
        name: "SDK Files",
      });
      return { ...user, token: key.token };
    }),
  );
  const [local, stranger, remote] = users;
  await ports.userDriveStore.upsertUserDrive({
    userId: remote!.userId,
    organizationId: DEFAULT_ORG_ID,
    drive9Server: supplierUrl,
    ownerKeySecretRef: "fictional-files-drive-owner",
    status: "ready",
  });
  const templateId = `template_${randomUUID().replaceAll("-", "")}`;
  await ports.agentStore.createAgentTemplate({
    organizationId: DEFAULT_ORG_ID,
    agentTemplateId: templateId,
    name: "SDK Files",
  });
  await fixture.arrangeAgentTemplateContent({
    organizationId: DEFAULT_ORG_ID,
    templateId,
    content: AgentTemplateContentSchema.parse({
      realtime: null,
      identity: { agentName: "SDK Files" },
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
          SDK_USER_KEY: local!.token,
          SDK_FOREIGN_USER_KEY: stranger!.token,
          SDK_FILE_REMOTE_USER_KEY: remote!.token,
          SDK_TEMPLATE_ID: templateId,
        },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    console.log(result.stdout);
  } catch (error) {
    const output = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `SDK file service cases failed:\n${output.stdout ?? ""}${output.stderr ?? ""}`,
    );
  }
}, 120000);
