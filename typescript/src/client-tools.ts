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
  `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/tools`;

export async function getClientTools(
  http: HttpClient,
  sessionId: string,
  options?: RequestOptions,
): Promise<ClientToolSet> {
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

export interface PendingClientToolCall {
  callId: string;
  turnId: string;
  name: string;
  arguments: Record<string, unknown>;
  publishedAt: string;
  deadlineAt: string;
}

export type ClientToolOutputInput = RequestOptions & {
  /** Persist a separate command identity; callId identifies the call, not this submission. */
  clientEventId: string;
  turnId: string;
  callId: string;
} & (
    | { output: string; error?: never }
    | { error: { message: string }; output?: never }
  );

export async function listPendingClientToolCalls(
  http: HttpClient,
  sessionId: string,
  options?: RequestOptions,
): Promise<PendingClientToolCall[]> {
  const result = await http.get<{ calls: PendingClientToolCall[] }>(
    `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/client-tool-calls`,
    options,
  );
  return result.calls;
}

export async function submitClientToolOutput(
  http: HttpClient,
  sessionId: string,
  input: ClientToolOutputInput,
): Promise<SessionInteraction> {
  requireKnownKeys(
    input,
    [
      "clientEventId",
      "turnId",
      "callId",
      "output",
      "error",
      "signal",
      "requestId",
    ],
    "Client Tool output",
  );
  requireCreationKey(input.clientEventId);
  for (const id of [input.turnId, input.callId])
    if (typeof id !== "string" || !id || id.length > 64)
      throw new TypeError(
        "Client Tool output requires turnId and callId containing 1-64 characters",
      );
  if (Object.hasOwn(input, "output") === Object.hasOwn(input, "error"))
    throw new TypeError("Provide exactly one Client Tool output or error");
  if ("output" in input) {
    if (typeof input.output !== "string" || input.output.length > 65536)
      throw new TypeError(
        "Client Tool output must be a string of at most 65536 characters",
      );
  } else {
    requireKnownKeys(input.error, ["message"], "Client Tool error");
    if (
      typeof input.error.message !== "string" ||
      !input.error.message ||
      input.error.message.length > 4096
    )
      throw new TypeError(
        "Client Tool error.message must contain 1-4096 characters",
      );
  }
  const { clientEventId, signal, requestId, ...data } = input;
  const turnId = data.turnId;
  signal?.throwIfAborted();
  try {
    const result = await http.postResponse<{ interaction?: unknown }>(
      `/api/v1/user/sessions/${encodeURIComponent(sessionId)}/events`,
      { type: "agent.session.input.client_tool_output", clientEventId, data },
      {
        outcomeUnknown: true,
        ...(signal ? { signal } : {}),
        ...(requestId ? { requestId } : {}),
      },
    );
    try {
      const receipt = requireInteraction(
        result.data?.interaction,
        clientEventId,
        result.requestId,
      );
      if (
        receipt.kind !== "client_tool_output" ||
        receipt.turnId !== turnId ||
        receipt.message !== null
      )
        throw new TiDBLinkError(
          "Client Tool output receipt identifies a different command",
        );
      return receipt;
    } catch (cause) {
      throw new OutcomeUnknownError(
        "Client Tool output returned no usable receipt; query the original input",
        { requestId: result.requestId, cause },
      );
    }
  } catch (cause) {
    if (!(cause instanceof OutcomeUnknownError)) throw cause;
    throw new OutcomeUnknownError(cause.message, {
      sessionId,
      inputId: clientEventId,
      turnId,
      ...(cause.requestId ? { requestId: cause.requestId } : {}),
      cause,
    });
  }
}
