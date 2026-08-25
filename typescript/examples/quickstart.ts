import { UserClient, WorkspaceClient } from "@mem9/agent-stack";

export async function runCustomerTurn(input: {
  baseUrl: string;
  workspaceApiKey: string;
  projectId: string;
  customerName: string;
  prompt: string;
}) {
  const workspace = new WorkspaceClient({
    baseUrl: input.baseUrl,
    apiKey: input.workspaceApiKey,
  });
  const serviceUser = await workspace.createServiceUser({ displayName: input.customerName });
  const { token: userApiKey } = await serviceUser.createApiKey({ name: "saas-backend" });

  // Persist serviceUser.id and userApiKey in your customer mapping and secret manager.
  const user = new UserClient({
    baseUrl: input.baseUrl,
    apiKey: userApiKey,
    projectId: input.projectId,
  });
  const agent = await user.createAgent({ name: `${input.customerName} Agent` });
  const session = await agent.createSession();
  return session.turn({ text: input.prompt });
}
