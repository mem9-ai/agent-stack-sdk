import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Persist sessionId, clientEventId and text before calling; reuse them for recovery. */
export async function sendMessageWorkflow({
  baseUrl,
  userApiKey,
  sessionId,
  clientEventId,
  text,
  timeoutMs,
  signal,
}) {
  const session = new UserClient({ baseUrl, apiKey: userApiKey }).session(
    sessionId,
  );
  return session.turn(
    { clientEventId, text, ...(signal ? { signal } : {}) },
    {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal ? { signal } : {}),
    },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await sendMessageWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      userApiKey: process.env.USER_API_KEY,
      sessionId: process.env.SESSION_ID,
      clientEventId: process.env.CLIENT_EVENT_ID,
      text: process.env.MESSAGE_TEXT,
    });
    console.log(result.text);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Message failed");
    process.exitCode = 1;
  }
}
