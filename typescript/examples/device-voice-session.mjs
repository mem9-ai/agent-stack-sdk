import { pathToFileURL } from "node:url";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";

/**
 * A backend that connects a voice device to a Session and runs the device's
 * tools. The device talks to TiDB Link directly over the Realtime WebSocket
 * with the short-lived connect token; the Organization API Key never leaves
 * the backend. Tool calls arrive on the backend's subscription, which forwards
 * them to the device over the backend's own channel and returns the results.
 */

/** Prepare the Realtime connection and return what the device needs to join it. */
export async function connectDevice({
  baseUrl,
  organizationApiKey,
  userId,
  sessionId,
  metadata,
}) {
  const session = new OrganizationClient({ baseUrl, apiKey: organizationApiKey })
    .user(userId)
    .session(sessionId);
  try {
    const opened = await session.openRealtimeConnection(
      metadata === undefined ? {} : { metadata },
    );
    return {
      websocketUrl: opened.websocketUrl,
      connectToken: opened.connectToken,
      connectTokenExpiresAt: opened.connectTokenExpiresAt,
    };
  } catch (error) {
    // The device reconnects to a connection that is still live.
    if (!(error instanceof TiDBLinkApiError) || error.code !== "realtime_connection_live")
      throw error;
    return session.createRealtimeConnectToken();
  }
}

/**
 * Follow the Session until `signal` aborts and answer each Client Tool call
 * with `executeOnDevice(call)`, which returns the output text or throws.
 * `saveCursor` persists the stream position so a restart resumes there.
 */
export async function serveDeviceTools({
  baseUrl,
  organizationApiKey,
  userId,
  sessionId,
  cursor,
  saveCursor,
  executeOnDevice,
  onDisconnect,
  signal,
}) {
  const session = new OrganizationClient({ baseUrl, apiKey: organizationApiKey })
    .user(userId)
    .session(sessionId);
  for await (const item of session.subscribe({
    ...(cursor ? { cursor } : {}),
    ...(signal ? { signal } : {}),
  })) {
    if (item.type === "event") {
      await saveCursor?.(item.event.cursor);
    } else if (item.type === "disconnected") {
      onDisconnect?.(item.error, item.retryInMs);
    } else {
      const { call } = item;
      let result;
      try {
        result = { output: await executeOnDevice(call) };
      } catch (error) {
        result = {
          error: { message: error instanceof Error ? error.message : "Device tool failed" },
        };
      }
      // A stable command identity makes a repeated submission after a restart harmless.
      await session.submitClientToolOutput({
        clientEventId: `device-tool.${call.callId}`,
        turnId: call.turnId,
        callId: call.callId,
        ...result,
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { AGENT_SERVICE_URL, ORGANIZATION_API_KEY, END_USER_ID, SESSION_ID } = process.env;
  if (!AGENT_SERVICE_URL || !ORGANIZATION_API_KEY || !END_USER_ID || !SESSION_ID)
    throw new Error("Set AGENT_SERVICE_URL, ORGANIZATION_API_KEY, END_USER_ID and SESSION_ID");
  const options = {
    baseUrl: AGENT_SERVICE_URL,
    organizationApiKey: ORGANIZATION_API_KEY,
    userId: END_USER_ID,
    sessionId: SESSION_ID,
  };
  const grant = await connectDevice(options);
  console.log(JSON.stringify({ websocketUrl: grant.websocketUrl, connectTokenExpiresAt: grant.connectTokenExpiresAt }));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  await serveDeviceTools({
    ...options,
    signal: controller.signal,
    saveCursor: (cursor) => console.error(`cursor ${cursor}`),
    // Replace with a call to your device channel.
    executeOnDevice: async (call) => JSON.stringify({ tool: call.name, ok: true }),
  });
}
