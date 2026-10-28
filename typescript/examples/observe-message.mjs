import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Observe an already submitted input. Persist each event cursor for reconnection. */
export function observeMessageWorkflow({
  baseUrl,
  userApiKey,
  sessionId,
  inputId,
  cursor,
  timeoutMs,
  signal,
}) {
  return new UserClient({ baseUrl, apiKey: userApiKey })
    .session(sessionId)
    .observe(inputId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal ? { signal } : {}),
    });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    for await (const update of observeMessageWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      userApiKey: process.env.USER_API_KEY,
      sessionId: process.env.SESSION_ID,
      inputId: process.env.INPUT_ID,
      cursor: process.env.EVENT_CURSOR,
    })) {
      if (update.type === "result") console.log(update.result.text);
      else console.error(JSON.stringify(update));
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Observation stopped",
    );
    process.exitCode = 1;
  }
}
