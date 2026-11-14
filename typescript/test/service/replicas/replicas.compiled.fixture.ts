import { execFile, fork, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { startSystemHarness } from "../test/system/support/system-harness";
import { SYSTEM_HARNESS_OPS_OWNER } from "../test/system/support/system-harness";
import { publishOpsReleaseOverHttp } from "../test/system/support/ops-release-http";
import {
  AGENT_MODEL_NAMES,
  DEFAULT_AGENT_MODEL,
} from "../src/agent-models/agent-model-registry";

const exec = promisify(execFile);

/**
 * Two replicas of the compiled backend. The installed SDK in a child process
 * attaches Sessions on either replica, through a local load balancer that
 * prefers replica B, while Turns run on the other replica. The child asks for
 * model responses and replica changes through IPC stages.
 */
it("the installed SDK keeps Session connections across replicas, drains and reconnects", async () => {
  const harness = await startSystemHarness({
    databaseAdminUrl: process.env.TEST_TIDB_DATABASE_URL!,
    tidbSsl: process.env.TIDB_SSL ?? "off",
    controlledDrive9: true,
  });
  const temporary = await mkdtemp(path.join(tmpdir(), "tidb-link-replicas-consumer-"));
  let child: ChildProcess | undefined;
  try {
    await publishOpsReleaseOverHttp({
      baseUrl: harness.baseUrl,
      owner: SYSTEM_HARNESS_OPS_OWNER,
      services: {
        models: [
          {
            provider: "openai_compatible",
            endpoint: harness.model.openAi.baseUrl,
            apiMode: "chat_completions",
            modelIds: AGENT_MODEL_NAMES,
            apiKey: harness.model.openAi.apiKey,
          },
        ],
        defaultModel: DEFAULT_AGENT_MODEL,
        sandbox: { provider: "local" },
        drive9: { server: harness.integrations.baseUrl, provisionMode: "anonymous" },
      },
    });
    const replica = await harness.startReplica();
    const organizationId = harness.fixtures.organization.id;
    const token = await harness.issueOrganizationCredential({
      organizationId,
      createdByUserId: null,
    });
    const template = await harness.publishAgentTemplateFixture({ name: "SDK replicas" });
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
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, packed.filename)],
      { cwd: temporary },
    );
    const [{ source }] = JSON.parse(process.env.SDK_SERVICE_CASES!);
    await copyFile(source, path.join(temporary, "consumer.mjs"));
    child = fork(path.join(temporary, "consumer.mjs"), [], {
      cwd: temporary,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        SDK_SERVICE_URL: harness.baseUrl,
        SDK_REPLICA_URL: replica.baseUrl,
        SDK_ORGANIZATION_KEY: token,
        SDK_TEMPLATE_ID: template.templateId,
      },
    });
    let output = "";
    child.stdout!.on("data", (bytes) => (output += bytes));
    child.stderr!.on("data", (bytes) => (output += bytes));
    let title: ReturnType<typeof harness.model.enqueueText> | undefined;
    let held: ReturnType<typeof harness.model.enqueueText> | undefined;
    const consumer = child;
    const toolTurn = (answer: string, output: string) => {
      harness.model.enqueueToolCalls({
        toolCalls: [{ id: `sdk_${answer.length}_${Date.now()}`, name: "set_light", arguments: { brightness: 40 } }],
      });
      harness.model.enqueueText({ chunks: [answer], expectRequest: { bodyIncludes: [output] } });
    };
    child.on("message", (message: { stage: string }) => {
      void (async () => {
        if (message.stage === "tool") {
          toolTurn("Dimmed.", "Lamp dimmed to 40%");
          // The Session's first Turn is followed by its background title.
          title = harness.model.enqueueText({
            chunks: ["SDK replicas"],
            expectRequest: { bodyIncludes: ["Generate exactly one concise session title."] },
          });
        } else if (message.stage === "stopB") {
          await title!.waitUntilRequested();
          // B announces connection.drain, then stops.
          await replica.stop();
        } else if (message.stage === "toolAgain") {
          toolTurn("Dimmed again.", "Lamp dimmed to 40%");
        } else if (message.stage === "held") {
          held = harness.model.enqueueText({ chunks: ["Held answer."], pauseBeforeResponse: true });
        } else if (message.stage === "awaitHeld") {
          await held!.waitUntilPaused();
        } else if (message.stage === "release") {
          held!.release();
        } else throw new Error(`Unknown fixture stage: ${message.stage}`);
        consumer.send({});
      })().catch((error) => consumer.send({ error: String(harness.redactError(error)) }));
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      consumer.once("error", reject);
      consumer.once("exit", resolve);
    });
    expect(code, String(harness.redactError(new Error(output)))).toBe(0);
    console.log(output);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(temporary, { recursive: true, force: true });
    const teardown = await harness.stop();
    expect(teardown.errors).toEqual([]);
  }
}, 240_000);
