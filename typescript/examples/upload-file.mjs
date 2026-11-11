import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

/** Persist both identities and exact file/message input before calling. */
export async function uploadFileWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  sessionId,
  originalName,
  bytes,
  idempotencyKey,
  clientEventId,
  text = "Read the attached file.",
  timeoutMs,
}) {
  const user = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  }).user(userId);
  const file = await user.files.upload({ originalName, bytes, idempotencyKey });
  const result = await user
    .session(sessionId)
    .turn(
      { clientEventId, text, userFileIds: [file.fileId] },
      { ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    );
  return { file, result };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.env.FILE_PATH)
      throw new Error("Set FILE_PATH to the file to attach");
    const { result } = await uploadFileWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      organizationApiKey: process.env.ORGANIZATION_API_KEY,
      userId: process.env.END_USER_ID,
      sessionId: process.env.SESSION_ID,
      originalName: basename(process.env.FILE_PATH),
      bytes: await readFile(process.env.FILE_PATH),
      idempotencyKey: process.env.UPLOAD_IDEMPOTENCY_KEY,
      clientEventId: process.env.CLIENT_EVENT_ID,
      text: process.env.MESSAGE_TEXT,
    });
    console.log(result.text);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "File workflow failed",
    );
    process.exitCode = 1;
  }
}
