# `@mem9/agent-stack`

Official TypeScript SDK for Agent Stack. The package requires Node.js 22.12 or
newer and has no runtime dependencies.

The SDK is ESM-only and ships TypeScript declarations.

## Install

```sh
npm install @mem9/agent-stack
```

## Quick start

The Workspace API Key needs `user-api-keys:manage`. Store the returned Service
User ID in your customer mapping and store the one-time User API Key in your
secret manager before continuing.

```ts
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

  const serviceUser = await workspace.createServiceUser({
    displayName: input.customerName,
  });
  const { token: userApiKey } = await serviceUser.createApiKey({
    name: "saas-backend",
  });

  // Persist serviceUser.id and userApiKey securely here. The plaintext key is
  // not available from list or revoke responses.
  const user = new UserClient({
    baseUrl: input.baseUrl,
    apiKey: userApiKey,
    projectId: input.projectId,
  });
  const agent = await user.createAgent({ name: `${input.customerName} Agent` });
  const session = await agent.createSession();
  return session.turn({ text: input.prompt });
}
```

`session.turn()` returns either an `answer` or a structured `clarification`.
Use `session.streamTurn()` when progress events are needed:

```ts
for await (const event of session.streamTurn({ text: "Continue" })) {
  if (event.event === "progress") process.stdout.write(event.payload.text);
}
```

## Clients and resources

- `WorkspaceClient` accepts a Workspace API Key. It creates Service Users and
  reconstructs a `ServiceUser` handle from a retained User ID.
- `ServiceUser` creates, lists, rotates, revokes, and bulk-revokes User API
  Keys. Plaintext is returned only by successful create and rotate calls.
- `UserClient` accepts a User API Key and is permanently bound to one Project.
  It manages the current User's Agents, AgentTemplates, and Sessions.
- `Agent` retains its latest ETag for rename, configure, and archive. A stale
  write throws `ConflictError`; call `refresh()` before reconciling.
- `Session` retains its model ETag, reads Turn history, and offers collected or
  streaming Turn APIs. Model changes affect future AgentRuns only.

The clients never accept caller-supplied Workspace, Organization, or User
identity headers. Identity comes from the API Key. `UserClient` alone sends the
required Project selection header.

## Errors and retry behavior

- `AgentStackApiError` preserves HTTP status, stable service error code,
  request identity, and display-safe details.
- `ConflictError` represents an explicit service conflict, including stale
  ETags.
- `TurnFailedError` and `TurnInterruptedError` represent known terminal Turn
  outcomes.
- `OutcomeUnknownError` means the operation may have happened. Do not repeat a
  credential, Session, or Turn mutation unless the service contract makes that
  specific request idempotent.
- Safe reads and server-idempotent Agent creation use bounded retries with one
  stable request identity. Credential create/rotate and Turn creation are never
  replayed automatically.
- `AbortSignal` stops local waiting. It does not promise remote cancellation or
  exactly-once external effects.

## Compatibility

`@mem9/agent-stack` 0.1.x targets Agent Service OpenAPI `0.0.1`, exported as
`AGENT_SERVICE_API_VERSION`.

Agent Service `0.0.1` does not yet expose three guarantees required for the
complete v1 product contract: atomic/idempotent Service User provisioning,
idempotent Session creation with an atomic initial model, and Turn lookup by a
stable request identity. The SDK therefore reports ambiguous current-service
outcomes explicitly and never claims those unavailable guarantees. Progress
stream resumption is intentionally outside v1.
