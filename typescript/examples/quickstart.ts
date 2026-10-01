import { OrganizationClient, UserClient } from "@mem9/agent-stack";

export async function runCustomerTurn(input: {
  baseUrl: string;
  organizationApiKey: string;
  serviceUserId: string;
  agentTemplateId: string;
  templateVersion: number;
  customerName: string;
  prompt: string;
}) {
  const organization = new OrganizationClient({
    baseUrl: input.baseUrl,
    apiKey: input.organizationApiKey,
  });
  const serviceUser = organization.serviceUser(input.serviceUserId);
  const { token: userApiKey } = await serviceUser.createApiKey({
    name: "saas-backend",
  });

  // Persist serviceUser.id and userApiKey in your customer mapping and secret manager.
  const user = new UserClient({
    baseUrl: input.baseUrl,
    apiKey: userApiKey,
  });
  const agent = await user.createAgent({
    agentTemplateId: input.agentTemplateId,
    templateVersion: input.templateVersion,
    name: `${input.customerName} Agent`,
  });
  const session = await agent.createSession();
  return session.turn({ text: input.prompt });
}
