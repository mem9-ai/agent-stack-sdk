import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Persist the exact runAt, prompt and creation key before calling. */
export async function scheduleTaskWorkflow({
  baseUrl,
  userApiKey,
  agentId,
  idempotencyKey,
  runAt,
  prompt,
  title = "Scheduled task",
  timeoutMs = 30000,
}) {
  const user = new UserClient({ baseUrl, apiKey: userApiKey });
  const created = await user.schedulers.create({
    agentId,
    idempotencyKey,
    title,
    prompt,
    schedule: { kind: "once", runAt },
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { fires } = await user.schedulers.fires(
      created.scheduler.schedulerId,
    );
    const fire = fires.find((item) => item.executionStatus !== "pending");
    if (fire) {
      const turn =
        fire.result.sessionId && fire.result.turnId
          ? await user
              .session(fire.result.sessionId)
              .getTurn(fire.result.turnId)
          : null;
      return { scheduler: created.scheduler, fire, turn };
    }
    await delay(100);
  }
  throw new Error(
    `Waiting stopped; read Scheduler ${created.scheduler.schedulerId} fires later. Its schedule remains active.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await scheduleTaskWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      userApiKey: process.env.USER_API_KEY,
      agentId: process.env.AGENT_ID,
      idempotencyKey: process.env.SCHEDULER_IDEMPOTENCY_KEY,
      runAt: process.env.SCHEDULE_RUN_AT,
      prompt: process.env.SCHEDULE_PROMPT,
    });
    console.log(JSON.stringify(result));
    if (result.fire.executionStatus === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Scheduled task failed",
    );
    process.exitCode = 1;
  }
}
