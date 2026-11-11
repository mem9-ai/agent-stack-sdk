import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@mem9/tidb-link";

/** Retain the owner, selected Template/model and both creation identities before calling. */
export async function organizationSessionWorkflow({
  baseUrl,
  organizationApiKey,
  userId,
  agentTemplateId,
  agentCreationKey,
  sessionCreationKey,
  model,
}) {
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
  const { agent, session } = await organizationSessionWorkflow({
    baseUrl: AGENT_SERVICE_URL,
    organizationApiKey: ORGANIZATION_API_KEY,
    userId: END_USER_ID,
    agentTemplateId: TEMPLATE_ID,
    agentCreationKey: AGENT_CREATION_KEY,
    sessionCreationKey: SESSION_CREATION_KEY,
    model: MODEL_ID,
  });
  console.log(JSON.stringify({ agentId: agent.id, sessionId: session.id }));
}
