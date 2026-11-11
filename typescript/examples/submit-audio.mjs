import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

/** This recording request owns its response; aborting it may interrupt the Turn. */
export async function submitAudioWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  sessionId,
  bytes,
  filename,
  contentType,
  billingTag,
  signal,
}) {
  return new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  }).user(userId)
    .session(sessionId)
    .audio({
      bytes,
      filename,
      ...(contentType === undefined ? {} : { contentType }),
      ...(billingTag === undefined ? {} : { billingTag }),
      ...(signal ? { signal } : {}),
    });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.env.AUDIO_FILE_PATH)
      throw new Error("Set AUDIO_FILE_PATH to an existing recording");
    const result = await submitAudioWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      organizationApiKey: process.env.ORGANIZATION_API_KEY,
      userId: process.env.END_USER_ID,
      sessionId: process.env.SESSION_ID,
      filename: basename(process.env.AUDIO_FILE_PATH),
      bytes: await readFile(process.env.AUDIO_FILE_PATH),
      contentType: process.env.AUDIO_CONTENT_TYPE,
    });
    console.log(result.text);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Audio request failed",
    );
    if (typeof error?.turnId === "string")
      console.error(`Turn: ${error.turnId}`);
    process.exitCode = 1;
  }
}
