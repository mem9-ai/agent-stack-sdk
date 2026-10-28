import { pathToFileURL } from "node:url";
import { UserClient, OrganizationClient } from "@mem9/tidb-link";

export async function readOwnUsage({ baseUrl, userApiKey, options = {} }) {
  const user = new UserClient({ baseUrl, apiKey: userApiKey });
  return {
    summary: await user.getUsage(options),
    details: await user.getUsageDetails(options),
  };
}

/** Organization details return the first page; retain nextCursor and the original filters. */
export async function readUserUsage({
  baseUrl,
  organizationApiKey,
  userId,
  options,
}) {
  const organization = new OrganizationClient({
    baseUrl,
    apiKey: organizationApiKey,
  });
  const { interval, ...range } = options;
  return {
    summary: await organization.getUserUsage(userId, options),
    details: await organization.getUserUsageDetails(userId, range),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = {
      from: process.env.USAGE_FROM,
      to: process.env.USAGE_TO,
      tagKey: process.env.TAG_KEY,
      tagValue: process.env.TAG_VALUE,
    };
    const baseUrl = process.env.AGENT_SERVICE_URL;
    let result;
    if (process.env.USAGE_AUTHORITY === "user")
      result = await readOwnUsage({
        baseUrl,
        userApiKey: process.env.USER_API_KEY,
        options,
      });
    else if (process.env.USAGE_AUTHORITY === "organization")
      result = await readUserUsage({
        baseUrl,
        organizationApiKey: process.env.ORGANIZATION_API_KEY,
        userId: process.env.END_USER_ID,
        options,
      });
    else throw new TypeError("USAGE_AUTHORITY must be user or organization");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Usage read failed");
    process.exitCode = 1;
  }
}
