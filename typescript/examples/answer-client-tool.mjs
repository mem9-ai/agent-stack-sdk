import { pathToFileURL } from "node:url";
import { UserClient } from "@mem9/tidb-link";

/** The application produces output/error itself and persists this command identity. */
export async function answerClientToolWorkflow({
  baseUrl,
  userApiKey,
  sessionId,
  turnId,
  callId,
  clientEventId,
  output,
  error,
  signal,
}) {
  const session = new UserClient({ baseUrl, apiKey: userApiKey }).session(
    sessionId,
  );
  const calls = await session.listPendingClientToolCalls(
    signal ? { signal } : undefined,
  );
  const call = calls.find(
    (call) => call.callId === callId && call.turnId === turnId,
  );
  if (!call)
    throw new Error(
      "The Session Client Tool call is no longer pending; reconcile the original output command before submitting anything else",
    );
  if (Date.parse(call.deadlineAt) <= Date.now())
    throw new Error(
      "The Client Tool deadline has passed; do not execute the business function again",
    );
  return session.submitClientToolOutput({
    clientEventId,
    turnId,
    callId,
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(signal ? { signal } : {}),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const receipt = await answerClientToolWorkflow({
      baseUrl: process.env.AGENT_SERVICE_URL,
      userApiKey: process.env.USER_API_KEY,
      sessionId: process.env.SESSION_ID,
      turnId: process.env.TURN_ID,
      callId: process.env.CALL_ID,
      clientEventId: process.env.CLIENT_EVENT_ID,
      output: process.env.TOOL_OUTPUT,
      ...(process.env.TOOL_ERROR === undefined
        ? {}
        : { error: { message: process.env.TOOL_ERROR } }),
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Client Tool result was not confirmed",
    );
    process.exitCode = 1;
  }
}
