import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  ConnectorAuthError,
  ConnectorKeySet,
  readConnectorCallContext,
  verifyConnectorCallback,
} from "@tidblink/server";

/**
 * A minimal HTTP Connector: an MCP server over Streamable HTTP with plain
 * JSON responses, without an MCP library. Every request must carry a
 * platform-signed token for this Organization and Connector; every tool call
 * carries the Call Context naming the End User it is for.
 *
 * `tools` maps a tool name to `{ description, inputSchema, run(args, context) }`.
 * `run` returns text; deduplicate its side effects by `context.callId`.
 * Agents see each tool as `mcp_<name>__<tool>`, both parts lowercased with
 * other characters replaced by `_`.
 */
export function createConnectorHandler({
  baseUrl,
  organizationId,
  connectorId,
  tools,
  name = "example-connector",
  keys = new ConnectorKeySet({ baseUrl }),
}) {
  const catalog = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const answer = (response, status, body) => {
    response.writeHead(status, body ? { "content-type": "application/json" } : {});
    response.end(body ? JSON.stringify(body) : undefined);
  };
  return async (request, response) => {
    try {
      await verifyConnectorCallback(request.headers.authorization, {
        keys,
        organizationId,
        connectorId,
      });
    } catch (error) {
      if (error instanceof ConnectorAuthError) return answer(response, 401);
      return answer(response, 503);
    }
    if (request.method === "DELETE") return answer(response, 200);
    if (request.method !== "POST") return answer(response, 405);
    let message;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return answer(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    // Notifications such as notifications/initialized need no answer.
    if (message.id === undefined) return answer(response, 202);
    const reply = (result) => answer(response, 200, { jsonrpc: "2.0", id: message.id, result });
    const fail = (code, text) =>
      answer(response, 200, { jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name, version: "1.0.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: catalog });
      case "tools/call": {
        const tool = tools[message.params?.name];
        if (!tool) return fail(-32602, "Unknown tool");
        let context;
        try {
          context = readConnectorCallContext(message.params?._meta, { organizationId });
        } catch (error) {
          return fail(-32602, error.message);
        }
        try {
          const text = await tool.run(message.params.arguments ?? {}, context);
          return reply({ content: [{ type: "text", text: String(text) }] });
        } catch (error) {
          return reply({
            content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }],
            isError: true,
          });
        }
      }
      default:
        return fail(-32601, "Method not found");
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { AGENT_SERVICE_URL, ORGANIZATION_ID, CONNECTOR_ID, PORT = "8080" } = process.env;
  if (!AGENT_SERVICE_URL || !ORGANIZATION_ID || !CONNECTOR_ID)
    throw new Error("Set AGENT_SERVICE_URL, ORGANIZATION_ID and CONNECTOR_ID; PORT is optional");
  const handler = createConnectorHandler({
    baseUrl: AGENT_SERVICE_URL,
    organizationId: ORGANIZATION_ID,
    connectorId: CONNECTOR_ID,
    tools: {
      lookup_order: {
        description: "Look up one of the user's orders",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
        run: async ({ orderId }, { userId }) =>
          JSON.stringify({ orderId, userId, status: "shipped" }),
      },
    },
  });
  // Serve behind your HTTPS terminator; register its HTTPS URL as endpointUrl.
  createServer(handler).listen(Number(PORT));
}
