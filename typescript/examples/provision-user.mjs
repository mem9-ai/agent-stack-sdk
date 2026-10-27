import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ConflictError,
  OrganizationClient,
  OutcomeUnknownError,
} from "@mem9/agent-stack";

/** Each successful invocation issues a new credential. Retain it in your secret manager. */
export async function provisionUser({
  baseUrl,
  organizationApiKey,
  externalId,
  displayName,
}) {
  const client = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const organization = await client.getOrganization();
  const mapping = externalId.trim();
  if (!mapping)
    throw new TypeError("externalId is required for reconciliation");
  const find = async () =>
    (await client.listEndUsers()).find((user) => user.externalId === mapping);
  let user = await find();
  if (!user) {
    try {
      user = await client.createEndUser({
        externalId: mapping,
        ...(displayName === undefined ? {} : { displayName }),
      });
    } catch (error) {
      if (
        !(error instanceof OutcomeUnknownError) &&
        !(error instanceof ConflictError && error.code === "resource_conflict")
      )
        throw error;
      user = await find().catch(() => undefined);
      if (!user) throw error;
    }
  }
  // Metadata cannot recover a lost token. This issuance is deliberately never repeated here.
  const issued = await client.createUserApiKey(user.userId, {
    name: "application-backend",
  });
  return { organization, user, ...issued };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const {
    AGENT_SERVICE_URL,
    ORGANIZATION_API_KEY,
    END_USER_EXTERNAL_ID,
    USER_CREDENTIAL_FILE,
  } = process.env;
  if (
    !AGENT_SERVICE_URL ||
    !ORGANIZATION_API_KEY ||
    !END_USER_EXTERNAL_ID ||
    !USER_CREDENTIAL_FILE
  ) {
    throw new Error(
      "Set AGENT_SERVICE_URL, ORGANIZATION_API_KEY, END_USER_EXTERNAL_ID and USER_CREDENTIAL_FILE",
    );
  }
  // Reserve a new private destination before issuing a credential; never overwrite an existing secret.
  const destination = await open(USER_CREDENTIAL_FILE, "wx", 0o600);
  try {
    const result = await provisionUser({
      baseUrl: AGENT_SERVICE_URL,
      organizationApiKey: ORGANIZATION_API_KEY,
      externalId: END_USER_EXTERNAL_ID,
    });
    await destination.writeFile(JSON.stringify(result) + "\n");
    console.log("User credential saved to USER_CREDENTIAL_FILE");
  } finally {
    await destination.close();
  }
}
