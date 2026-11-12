import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

/** Retain the owner, selected Template, optional model and the creation key before calling. */
export async function createSessionWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  templateId,
  sessionCreationKey,
  model,
}) {
  if (!templateId)
    throw new TypeError(
      "Select and retain a templateId before creating a Session",
    );
  const organization = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const user = organization.user(userId);
  const templates = await user.listAgentTemplates();
  const models = await user.listModels();
  // Omission is part of the creation identity; resolving today's default would change a replay.
  const session = await user.createSession({
    templateId,
    idempotencyKey: sessionCreationKey,
    ...(model === undefined ? {} : { model }),
  });
  return { organization, user, session, templates, models };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    AGENT_SERVICE_URL,
    ORGANIZATION_API_KEY,
    END_USER_ID,
    TEMPLATE_ID,
    SESSION_CREATION_KEY,
    MODEL_ID,
  } = process.env;
  if (
    !AGENT_SERVICE_URL ||
    !ORGANIZATION_API_KEY ||
    !END_USER_ID ||
    !TEMPLATE_ID ||
    !SESSION_CREATION_KEY
  )
    throw new Error(
      "Set AGENT_SERVICE_URL, ORGANIZATION_API_KEY, END_USER_ID, TEMPLATE_ID and SESSION_CREATION_KEY; MODEL_ID is optional",
    );
  const result = await createSessionWorkflow({
    baseUrl: AGENT_SERVICE_URL,
    organizationApiKey: ORGANIZATION_API_KEY,
    userId: END_USER_ID,
    sessionCreationKey: SESSION_CREATION_KEY,
    templateId: TEMPLATE_ID,
    model: MODEL_ID,
  });
  console.log(
    JSON.stringify({
      sessionId: result.session.id,
      model: result.session.model,
    }),
  );
}
