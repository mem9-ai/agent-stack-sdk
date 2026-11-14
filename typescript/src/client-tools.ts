import { requireInteraction, type SessionInteraction } from "./history.js";
import { OutcomeUnknownError, TiDBLinkError } from "./errors.js";
import {
  HttpClient,
  requireEtag,
  requireKnownKeys,
  requireCreationKey,
  type HttpResult,
} from "./http.js";
import type { RequestOptions } from "./organization.js";

export interface ClientToolDeclaration {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ClientToolSet {
  revision: number;
  tools: ClientToolDeclaration[];
  /** Pass this exact value when replacing the complete set. */
  etag: string;
}

export interface ReplaceClientToolsOptions extends RequestOptions {
  ifMatch: string;
}

export function validateClientTools(
  tools: readonly ClientToolDeclaration[],
): void {
  if (!Array.isArray(tools) || tools.length > 64)
    throw new TypeError("tools must be an array of at most 64 declarations");
  for (const tool of tools) {
    requireKnownKeys(
      tool,
      ["type", "name", "description", "parameters"],
      "Client Tool declaration",
    );
    if (
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      !tool.name ||
      typeof tool.description !== "string" ||
      !tool.description ||
      typeof tool.parameters !== "object" ||
      tool.parameters === null ||
      Array.isArray(tool.parameters)
    )
      throw new TypeError(
        "Client Tools require a function name, description and JSON Schema parameters",
      );
  }
}

const toolSet = (
  result: HttpResult<Omit<ClientToolSet, "etag">>,
): ClientToolSet => {
  if (
    !Number.isSafeInteger(result.data?.revision) ||
    result.data.revision < 0 ||
    !Array.isArray(result.data.tools)
  )
    throw new TiDBLinkError("TiDB Link returned an invalid Client Tool set", {
      requestId: result.requestId,
    });
  return { ...result.data, etag: requireEtag(result) };
};
const toolsPath = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/tools`;

export async function getClientTools(
  http: HttpClient,
  sessionId: string,
  options?: RequestOptions,
): Promise<ClientToolSet> {
  if (options)
    requireKnownKeys(
      options,
      ["signal", "requestId"],
      "Client Tool read options",
    );
  return toolSet(await http.getResponse(toolsPath(sessionId), options));
}

export async function replaceClientTools(
  http: HttpClient,
  sessionId: string,
  tools: readonly ClientToolDeclaration[],
  options: ReplaceClientToolsOptions,
): Promise<ClientToolSet> {
  validateClientTools(tools);
  requireKnownKeys(
    options,
    ["ifMatch", "signal", "requestId"],
    "Client Tool replacement options",
  );
  if (typeof options.ifMatch !== "string" || !options.ifMatch)
    throw new TypeError("Client Tool replacement requires ifMatch");
  const result = await http.response<Omit<ClientToolSet, "etag">>(
    toolsPath(sessionId),
    { method: "PUT", body: { tools }, outcomeUnknown: true, ...options },
  );
  try {
    return toolSet(result);
  } catch (cause) {
    throw new OutcomeUnknownError(
      "Client Tool replacement returned no usable receipt; read the current set before retrying",
      { sessionId, requestId: result.requestId, cause },
    );
  }
}
