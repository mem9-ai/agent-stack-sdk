import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

/** Retain the owner, selected Template, optional model and both creation keys before calling. */
export async function createSessionWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  agentTemplateId,
  agentCreationKey,
  sessionCreationKey,
  model,
}) {
  if (!agentTemplateId)
    throw new TypeError(
      "Select and retain an agentTemplateId before creating an Agent",
    );
  const organization = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const user = organization.user(userId);
  const templates = await user.listAgentTemplates();
  const models = await user.listModels();
  const agent = await user.createAgent({
    agentTemplateId,
    idempotencyKey: agentCreationKey,
  });
  // Omission is part of the creation identity; resolving today's default would change a replay.
  const session = await agent.createSession({
    idempotencyKey: sessionCreationKey,
    ...(model === undefined ? {} : { model }),
  });
  return { organization, user, agent, session, templates, models };
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
    AGENT_CREATION_KEY,
    SESSION_CREATION_KEY,
    MODEL_ID,
  } = process.env;
  if (
    !AGENT_SERVICE_URL ||
    !ORGANIZATION_API_KEY ||
    !END_USER_ID ||
    !TEMPLATE_ID ||
    !AGENT_CREATION_KEY ||
    !SESSION_CREATION_KEY
  )
    throw new Error(
      "Set AGENT_SERVICE_URL, ORGANIZATION_API_KEY, END_USER_ID, TEMPLATE_ID, AGENT_CREATION_KEY and SESSION_CREATION_KEY; MODEL_ID is optional",
    );
  const result = await createSessionWorkflow({
    baseUrl: AGENT_SERVICE_URL,
    organizationApiKey: ORGANIZATION_API_KEY,
    userId: END_USER_ID,
    agentCreationKey: AGENT_CREATION_KEY,
    sessionCreationKey: SESSION_CREATION_KEY,
    agentTemplateId: TEMPLATE_ID,
    model: MODEL_ID,
  });
  console.log(
    JSON.stringify({
      agentId: result.agent.id,
      sessionId: result.session.id,
      model: result.session.model,
    }),
  );
}
