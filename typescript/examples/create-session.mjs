import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Save the selected Template, optional model and both keys before calling. */
export async function createSessionWorkflow({
  baseUrl,
  userApiKey,
  agentTemplateId,
  agentCreationKey,
  sessionCreationKey,
  model,
}) {
  if (!agentTemplateId)
    throw new TypeError(
      "Select and retain an agentTemplateId before creating an Agent",
    );
  const user = new UserClient({ baseUrl, apiKey: userApiKey });
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
  return { agent, session, templates, models };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    AGENT_SERVICE_URL,
    USER_API_KEY,
    TEMPLATE_ID,
    AGENT_CREATION_KEY,
    SESSION_CREATION_KEY,
    MODEL_ID,
  } = process.env;
  if (
    !AGENT_SERVICE_URL ||
    !USER_API_KEY ||
    !TEMPLATE_ID ||
    !AGENT_CREATION_KEY ||
    !SESSION_CREATION_KEY
  )
    throw new Error(
      "Set AGENT_SERVICE_URL, USER_API_KEY, TEMPLATE_ID, AGENT_CREATION_KEY and SESSION_CREATION_KEY; MODEL_ID is optional",
    );
  const result = await createSessionWorkflow({
    baseUrl: AGENT_SERVICE_URL,
    userApiKey: USER_API_KEY,
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
