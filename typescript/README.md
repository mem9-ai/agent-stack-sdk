# `@mem9/tidb-link`

Official TypeScript SDK for TiDB Link. The package requires Node.js 22.12 or
newer, uses ESM and has no runtime dependencies.

## Install

```sh
npm install @mem9/tidb-link
```

## Quick start

Use an Organization Key to provision a native Business User in the key's
Organization. Store its identity in your customer mapping and the one-time User
Key in your secret manager. This creates an application identity without granting
Console membership.

```ts
import { OrganizationClient, UserClient } from "@mem9/tidb-link";

const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
const current = await organization.getOrganization();
const businessUser = await organization.createBusinessUser({
  externalId: "customer-42",
  displayName: "Customer",
});
const { token } = await businessUser.createApiKey({ name: "saas-backend" });
// Persist businessUser.id and token securely before proceeding.
const user = new UserClient({ baseUrl, apiKey: token });
const page = await user.listAgentTemplates();
const agent = await user.createAgent({ agentTemplateId: page.templates[0]!.agentTemplateId });
const session = await agent.createSession();
const result = await session.turn({ text: "Hello" });
```

The typed, runnable functions are in `examples/quickstart.ts`. Retain a customer's
User Key across requests; key issuance and rotation expose plaintext only in their
successful response. After an uncertain Business User creation, list Users and
match your unique `externalId` before provisioning again.

## Clients and resources

`OrganizationClient` reads the current Organization and creates, lists and reads
its Business Users. `businessUser(id)` reconstructs a retained credential handle.
`BusinessUser` creates, lists, rotates, revokes and bulk-revokes User Keys.

`UserClient` uses a User Key for that User's private resources. The published
Template directory returns summaries and pagination only. `createAgent` selects
one Template; repeated creation recovers the same effective User × Template
association. `Agent` supports read, refresh and unlink. It also retains private
Memory key reveal/replace; `UserClient` retains Memory key validation.

Each new Session uses the latest available publication and fixes its executable
behavior and answer model at creation. A later publication affects new Sessions.
Current authorization and dependency availability still govern execution.
`UserClient` lists and reconstructs Sessions. `Session` reads supported metadata,
renames, changes its billing tag and deletes; its model is read-only.

The clients derive Organization and User authority from their API Key. Credentials
use `ti_org_<id>_<secret>` and `ti_user_<id>_<secret>` respectively. IDs contain
1–64 ASCII letters or digits and secrets contain exactly 43 base64url characters.
Invalid, previous-format or other-kind keys fail before dispatch without including
the credential in errors. One-time issuance responses require a valid User Key.

## Turn results and connections

`session.turn()` collects an answer or structured clarification;
`session.streamTurn()` yields validated progress and terminal events. The request
that starts execution owns its stream. Normal completion closes the response and
keeps the Session available. Ending the stream early requests interruption.
The customer backend owns its downstream application-user connections and can
keep the upstream execution request open when a user closes a page.

## Errors and retry behavior

- `TiDBLinkApiError` preserves status, service error code, request identity and
  display-safe details. `ConflictError` represents an explicit service conflict.
- `TurnFailedError` and `TurnInterruptedError` distinguish terminal outcomes.
- `OutcomeUnknownError` means a dispatched mutation or stream may have been
  accepted. Use the operation's recovery contract before repeating it.
- Safe reads and server-idempotent Agent association creation use bounded retries
  with one request identity. One-time credential create/rotate and execution
  streams are never automatically replayed.

## Compatibility

This source targets TiDB Link OpenAPI `0.0.1`. The exact supported backend revision
is exported as `TIDB_LINK_REVISION` and declared in `package.json`. CI validates the
SDK against immutable generated OpenAPI bytes for that revision. SDK source
updates and npm package publication are separate actions.

The supported customer workflow exposes message/cancellation and saved results.
Console Template authoring and Draft Preview remain separate. Application-side
function-result submission, independent progress subscriptions and transient
stream replay are outside this SDK surface.
