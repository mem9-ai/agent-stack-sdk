import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** Keep both creation keys with the application's workflow record before calling. */
export async function createSessionWorkflow({
  baseUrl,
  userApiKey,
  agentTemplateId,
  agentCreationKey,
  sessionCreationKey,
  model,
}) {
  const user = new UserClient({ baseUrl, apiKey: userApiKey });
  if (!agentTemplateId) {
    let cursor;
    do {
      const page = await user.listAgentTemplates(cursor ? { cursor } : {});
      agentTemplateId = page.templates[0]?.agentTemplateId;
      cursor = page.nextCursor;
      if (agentTemplateId || !page.hasMore) break;
      if (!cursor) throw new Error("Template continuation omitted a cursor");
    } while (cursor);
  }
  if (!agentTemplateId)
    throw new Error("No available Template; provide an available TEMPLATE_ID");
  const models = await user.listModels();
  const agent = await user.createAgent({
    agentTemplateId,
    idempotencyKey: agentCreationKey,
  });
  const session = await agent.createSession({
    idempotencyKey: sessionCreationKey,
    model: model ?? models.effectiveDefaultModel,
  });
  return { agent, session, models };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    AGENT_SERVICE_URL,
    USER_API_KEY,
    AGENT_CREATION_KEY,
    SESSION_CREATION_KEY,
    TEMPLATE_ID,
    MODEL_ID,
  } = process.env;
  if (
    !AGENT_SERVICE_URL ||
    !USER_API_KEY ||
    !AGENT_CREATION_KEY ||
    !SESSION_CREATION_KEY
  )
    throw new Error(
      "Set AGENT_SERVICE_URL, USER_API_KEY, AGENT_CREATION_KEY and SESSION_CREATION_KEY; TEMPLATE_ID and MODEL_ID are optional",
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
