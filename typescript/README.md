# `@mem9/tidb-link`

Official TypeScript SDK for TiDB Link. The package requires Node.js 22.12 or
newer and has no runtime dependencies.

The SDK is ESM-only and ships TypeScript declarations.

## Install

```sh
npm install @mem9/tidb-link
```

## Quick start

The Organization API Key authenticates its Organization; the server authorizes each supported handler. Create the Service User
in the Console first, then store its ID in your customer mapping. Store the
one-time User API Key in your secret manager.

```ts
import { OrganizationClient, UserClient } from "@mem9/tidb-link";

export async function runCustomerTurn(input: {
  baseUrl: string;
  organizationApiKey: string;
  serviceUserId: string;
  agentTemplateId: string;
  templateVersion: number;
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
  const agent = await user.createAgent({
    agentTemplateId: input.agentTemplateId,
    templateVersion: input.templateVersion,
    name: `${input.customerName} Agent`,
  });
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
  Organization scope. It reconstructs a `ServiceUser` handle from a retained
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

Credentials use `ti_org_<id>_<secret>` for `OrganizationClient` and
`ti_user_<id>_<secret>` for `UserClient`. IDs contain 1–64 ASCII letters or digits;
the secret contains exactly 43 base64url characters. Constructors reject a key
of the other kind, malformed values and previous credential formats before making
a request. One-time create/rotate responses must contain a valid User Key.
The renamed package, error classes and compatibility exports have no old aliases.

## Errors and retry behavior

- `TiDBLinkApiError` preserves HTTP status, stable service error code,
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

`@mem9/tidb-link` 0.3.x targets TiDB Link OpenAPI `0.0.1` at revision
`7c12ed1a4f75ebb808b642f07f8fcd25259cf0f6`, exported as
`TIDB_LINK_API_VERSION` and `TIDB_LINK_REVISION`.

Credential creation and Session creation still report ambiguous transport
outcomes explicitly and are not retried. Progress-stream resumption is outside
the current supported surface.

## Published templates and descriptive Hardware

New Agents require an explicit `agentTemplateId`. Add `templateVersion` to choose
an exact publication; ID-only selection pins latest once on the server. Published
content is available through `getPublishedTemplateVersion`. `Agent.data` reports
its immutable creation origin, independent instructions and current application.

`config.hardware.requirements` and `overrides.hardware.requirements` contain exact
Definition IDs and capability names. They describe metadata without assigning a
device or granting execution. Explicit empty arrays survive upgrades. Preview an
idle Agent upgrade with `previewTemplateApplication`, then use `applyTemplate`
with the expected application, selected reset paths and one stable retry key.
`hardware.requirements` is a supported reset path. Existing default-Agent ensure
only returns an established mapping; if absent, explicitly create from a published
Template first. This SDK exposes personal User-key APIs; Console unsaved Draft
Preview remains a separate browser-cookie workflow.
