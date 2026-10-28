import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Prepare an existing owned Session for a terminal to connect; this does not open a WebSocket. */
export async function prepareRealtimeConnection({
  baseUrl,
  userApiKey,
  sessionId,
  realtimeModelId,
  audio,
  metadata,
}) {
  const client = new UserClient({ baseUrl, apiKey: userApiKey });
  const catalog = await client.listRealtimeModels();
  const session = client.session(sessionId);
  let selection = await session.getRealtimeModelSelection();
  if (
    realtimeModelId !== undefined &&
    realtimeModelId !== selection.model
  ) {
    selection = await session.setRealtimeModel(realtimeModelId, {
      ifMatch: selection.etag,
    });
  }
  const prepared = await session.openRealtimeConnection({
    ...(audio === undefined ? {} : { audio }),
    ...(metadata === undefined ? {} : { metadata }),
  });
  return { catalog, selection, ...prepared };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    AGENT_SERVICE_URL,
    USER_API_KEY,
    SESSION_ID,
    REALTIME_MODEL_ID,
  } = process.env;
  if (!AGENT_SERVICE_URL || !USER_API_KEY || !SESSION_ID) {
    throw new Error(
      "Set AGENT_SERVICE_URL, USER_API_KEY and SESSION_ID; REALTIME_MODEL_ID is optional",
    );
  }
  const result = await prepareRealtimeConnection({
    baseUrl: AGENT_SERVICE_URL,
    userApiKey: USER_API_KEY,
    sessionId: SESSION_ID,
    ...(REALTIME_MODEL_ID ? { realtimeModelId: REALTIME_MODEL_ID } : {}),
  });
  // The one-time connect token is returned to imported callers but never printed by this CLI.
  console.log(
    JSON.stringify({
      realtimeConnection: result.realtimeConnection,
      websocketUrl: result.websocketUrl,
      connectTokenExpiresAt: result.connectTokenExpiresAt,
    }),
  );
}
