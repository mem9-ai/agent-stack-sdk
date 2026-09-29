# `@mem9/agent-stack`

Official TypeScript SDK for Agent Stack. The package requires Node.js 22.12 or
newer and has no runtime dependencies.

The SDK is ESM-only and ships TypeScript declarations.

## Install

```sh
npm install @mem9/agent-stack
```

## Quick start

The Organization API Key needs `user-api-keys:manage`. Create the Service User
in the Console first, then store its ID in your customer mapping. Store the
one-time User API Key in your secret manager.

```ts
import { OrganizationClient, UserClient } from "@mem9/agent-stack";

export async function runCustomerTurn(input: {
  baseUrl: string;
  organizationApiKey: string;
  serviceUserId: string;
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

  // Persist serviceUser.id and userApiKey securely here. The plaintext key is
  // not available from list or revoke responses.
  const user = new UserClient({
    baseUrl: input.baseUrl,
    apiKey: userApiKey,
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

- `OrganizationClient` accepts an Organization API Key with
  `user-api-keys:manage`. It reconstructs a `ServiceUser` handle from a retained
  User ID; Service User creation remains a Console action.
- `ServiceUser` creates, lists, rotates, revokes, and bulk-revokes User API
  Keys. Plaintext is returned only by successful create and rotate calls.
- `UserClient` accepts a User API Key and manages only that User's resources.
  It manages the current User's Agents, AgentTemplates, and Sessions.
- `Agent` retains its latest ETag for rename, configure, and archive. A stale
  write throws `ConflictError`; call `refresh()` before reconciling.
- `Agent` exposes Memory enablement plus provider and credential state. Creation
  can provision or accept a mem9 Key. `UserClient` validates a key, while
  creator-only `Agent` methods reveal or replace it without putting plaintext in
  Agent records.
- `Session` retains its model ETag, reads Turn history, and offers collected or
  streaming Turn APIs. Model changes affect future AgentRuns only. Clarification
  replies preserve canonical ordered string values and their source Turn.

The clients never accept caller-supplied Organization or User identity headers.
Identity comes from the API Key.

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

`@mem9/agent-stack` 0.2.x targets Agent Service OpenAPI `0.0.1` at revision
`9c1e9aceb28afce1166e4249ea104c7a2f8aac73`, exported as
`AGENT_SERVICE_API_VERSION` and `AGENT_SERVICE_REVISION`.

Credential creation and Session creation still report ambiguous transport
outcomes explicitly and are not retried. Progress-stream resumption is outside
the current supported surface.
