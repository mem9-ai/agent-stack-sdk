import { OrganizationClient, UserClient, type Session, type InteractionReceipt } from "@mem9/tidb-link";

/** First-time customer admission. Retain the returned identity and key securely. */
export async function provisionCustomer(input: {
  baseUrl: string;
  organizationApiKey: string;
  externalId: string;
  displayName: string;
}) {
  const organization = new OrganizationClient({ baseUrl: input.baseUrl, apiKey: input.organizationApiKey });
  const businessUser = await organization.createBusinessUser({ externalId: input.externalId, displayName: input.displayName });
  const { token } = await businessUser.createApiKey({ name: "saas-backend" });
  return { businessUserId: businessUser.id, userApiKey: token };
}

/** Persist creationKey and inputId with this exact request intent before calling. */
export async function runCustomerTurn(input: {
  baseUrl: string;
  userApiKey: string;
  agentTemplateId: string;
  creationKey: string;
  inputId: string;
  prompt: string;
}) {
  const user = new UserClient({ baseUrl: input.baseUrl, apiKey: input.userApiKey });
  const agent = await user.createAgent({ agentTemplateId: input.agentTemplateId });
  const session = await agent.createSession({ idempotencyKey: input.creationKey });
  const result = await session.turn({ inputId: input.inputId, text: input.prompt });
  if (result.type === "receipt") {
    return { sessionId: session.id, interaction: result.interaction, currentTurn: await session.getTurn(result.interaction.turnId) };
  }
  return { sessionId: session.id, result };
}

/** Optional controls use separate saved input IDs and leave the original stream open. */
export async function runInteractiveTurn(session: Session, input: {
  inputId: string;
  text: string;
  steering?: { inputId: string; text: string };
  cancelInputId?: string;
}, onProgress: (text: string) => void) {
  const acknowledgments: InteractionReceipt[] = [];
  for await (const item of session.streamTurn({ inputId: input.inputId, text: input.text })) {
    if ("type" in item) {
      acknowledgments.push(item);
      continue;
    }
    if (item.event === "turn_started") {
      if (input.steering) {
        const steering = await session.turn(input.steering);
        if (steering.type !== "receipt") throw new Error("Expected an active Turn receipt");
        acknowledgments.push(steering);
      }
      if (input.cancelInputId) acknowledgments.push(await session.stopTurn(item.turnId, { inputId: input.cancelInputId }));
    }
    if (item.event === "progress") onProgress(item.payload.text);
  }
  const interaction = await session.getInteraction(input.inputId);
  return { acknowledgments, interaction, currentTurn: await session.getTurn(interaction.turnId) };
}

/** Use after a lost response; an input's original generation may still be running. */
export async function recoverInput(session: Session, inputId: string) {
  const interaction = await session.getInteraction(inputId);
  return { interaction, currentTurn: await session.getTurn(interaction.turnId) };
}
