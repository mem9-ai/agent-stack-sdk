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
// Persist these identities with the original request before dispatch.
const creationKey = "customer-42:conversation-001";
const inputId = "message-001";
const session = await agent.createSession({ idempotencyKey: creationKey });
const result = await session.turn({ inputId, text: "Hello" });
if (result.type === "receipt") {
  const saved = await session.getInteraction(inputId);
  const currentTurn = await session.getTurn(saved.turnId);
} else {
  console.log(result.text);
}
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
association. `Agent` supports read, refresh and unlink, retaining the returned archived
association after unlink. It also retains private
Memory key reveal/replace; `UserClient` retains Memory key validation.

Each new Session uses the latest available publication and fixes its executable
behavior and answer model at creation. A later publication affects new Sessions.
Current authorization and dependency availability still govern execution.
`Session.data.template` reports the fixed publication identity, version and
content digest without exposing its private execution recipe. `UserClient` lists
and reconstructs Sessions. `Session` reads supported metadata,
renames, changes its billing tag and deletes; its model is read-only.

The clients derive Organization and User authority from their API Key. Credentials
use `ti_org_<id>_<secret>` and `ti_user_<id>_<secret>` respectively. IDs contain
1–64 ASCII letters or digits and secrets contain exactly 43 base64url characters.
Invalid, previous-format or other-kind keys fail before dispatch without including
the credential in errors. One-time issuance responses require a valid User Key.

## Turn results and connections

`session.turn({inputId,text})` collects an answer, structured clarification or a
saved receipt. `session.streamTurn` yields native progress/terminal events for a
new Turn, or one discriminated SDK `type: "receipt"` item for active-message
admission or identical replay. A receipt is saved input admission and outcome,
not an assistant answer or a transient NDJSON event. `replayed` distinguishes an
identical replay; `interaction.mode === "rejected"` preserves a saved refusal.

```ts
for await (const item of session.streamTurn({ inputId: "message-002", text: "Plan the work" })) {
  if ("type" in item) continue; // Saved receipt: read its interaction/result.
  if (item.event === "turn_started") {
    const steering = await session.turn({ inputId: "steer-001", text: "Include costs" });
    // An application can stop the same task with a separate input identity.
    const stopping = await session.stopTurn(item.turnId, { inputId: "cancel-001" });
  }
  if (item.event === "progress") process.stdout.write(item.payload.text);
}
const page = await session.listInteractions({ limit: 50 });
const saved = await session.getInteraction("message-002");
const currentTurn = await session.getTurn(saved.turnId);
```

An active plain-text message is admitted into the same Turn. `appliedAt` reports
native incorporation; cancellation admission and a terminal outcome are separate
facts. Query the saved interaction's `result` to distinguish running, succeeded,
failed and interrupted. Paginate with `nextCursor`, and read a record by original
inputId. Turn content contains ordered `userMessages`, the initial `userMessage`,
final assistant and public Operations.

The interaction retains its original execution generation's terminal result.
An advanced explicit checkpoint retry can change the current Turn returned by
`getTurn`; repeating an original inputId recovers its saved generation and never
starts that retry. `getTurn` is current saved content, not an immutable transcript
of each past execution generation.

The request that starts execution owns its stream. Consume it through terminal
and EOF; ending iteration or aborting before completion closes that owning
request and requests interruption. Auxiliary steering/cancel receipts leave it
open. Normal completion keeps the Session available. The customer backend owns
its downstream application-user connections and can keep the upstream execution
request open when a user closes a page.

## Errors and recovery

- `TiDBLinkApiError` preserves status, service error code, tracing identity and
  display-safe details. `ConflictError` includes conflicting Session/input reuse.
- `TurnFailedError` and `TurnInterruptedError` distinguish known terminal outcomes.
- `OutcomeUnknownError` means a dispatched mutation or stream may have been
  accepted. Session creation errors preserve `idempotencyKey`; message/cancel
  errors preserve `inputId` and the known Turn. Request tracing is separate.
- Reissue an uncertain Session creation with its original key and body. Query
  `getInteraction(inputId)` after an uncertain message or cancellation, and use
  `getTurn` for current saved content. An unrecorded input is a scoped 404; saved
  refusals remain readable. Identical input resubmission returns a saved receipt.
- Session keys and input IDs contain 1–128 safe ASCII letters/digits/underscore/
  dot/colon/hyphen and begin with a letter or digit. Persist each identity and
  request intent before sending it. Reuse it only for that exact submission.
- Safe reads and server-idempotent Agent association creation use bounded retries.
  Session creation, input streams, cancellation and one-time key create/rotate
  each make one automatic dispatch. Execution streams are never replayed.

## Compatibility

This source targets TiDB Link OpenAPI `0.0.1`. The exact supported backend revision
is exported as `TIDB_LINK_REVISION` and declared in `package.json`. CI validates the
SDK against immutable generated OpenAPI bytes for that revision. SDK source
updates and npm package publication are separate actions.

The supported customer workflow exposes message/cancellation and saved results.
Console Template authoring and Draft Preview remain separate. Application-side
function-result submission, independent progress subscriptions and transient
stream replay are outside this SDK surface.
