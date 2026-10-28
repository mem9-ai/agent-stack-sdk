import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Persist the action and both identities before dispatch; recovery reads that command. */
export async function controlTurnWorkflow({
  baseUrl,
  userApiKey,
  sessionId,
  turnId,
  clientEventId,
  action,
  signal,
}) {
  if (action !== "cancel" && action !== "retry")
    throw new TypeError("action must be cancel or retry");
  const session = new UserClient({ baseUrl, apiKey: userApiKey }).session(
    sessionId,
  );
  const input = { turnId, clientEventId, ...(signal ? { signal } : {}) };
  if (action === "cancel") return session.cancel(input);
  const accepted = await session.retry(input);
  return session.waitForResult(
    accepted.clientEventId,
    signal ? { signal } : undefined,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await controlTurnWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      userApiKey: process.env.USER_API_KEY,
      sessionId: process.env.SESSION_ID,
      turnId: process.env.TURN_ID,
      clientEventId: process.env.CLIENT_EVENT_ID,
      action: process.env.TURN_ACTION,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Turn control failed",
    );
    process.exitCode = 1;
  }
}
