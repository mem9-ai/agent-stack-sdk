import { pathToFileURL } from "node:url";
import { OrganizationClient } from "@tidblink/server";

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
    const result = await readUserUsage({
      baseUrl: process.env.AGENT_SERVICE_URL,
      organizationApiKey: process.env.ORGANIZATION_API_KEY,
      userId: process.env.END_USER_ID,
      options,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Usage read failed");
    process.exitCode = 1;
  }
}
