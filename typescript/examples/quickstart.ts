import { OrganizationClient, UserClient } from "@mem9/tidb-link";

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

export async function runCustomerTurn(input: {
  baseUrl: string;
  userApiKey: string;
  agentTemplateId: string;
  prompt: string;
}) {
  const user = new UserClient({ baseUrl: input.baseUrl, apiKey: input.userApiKey });
  const agent = await user.createAgent({ agentTemplateId: input.agentTemplateId });
  const session = await agent.createSession();
  return session.turn({ text: input.prompt });
}
