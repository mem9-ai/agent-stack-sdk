import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

/** Persist sessionId, clientEventId and text before calling; reuse them for recovery. */
export async function sendMessageWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  sessionId,
  clientEventId,
  text,
  timeoutMs,
  signal,
}) {
  const session = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  }).user(userId).session(
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
      organizationApiKey: process.env.ORGANIZATION_API_KEY,
      userId: process.env.END_USER_ID,
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
