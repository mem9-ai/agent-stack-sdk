# `@mem9/tidb-link`

Official TypeScript SDK for Node.js 22.12 or newer. ESM only, with TypeScript
declarations and no runtime dependencies.

## Current refresh scope

This refresh supports Organization information, End User provisioning, User API
Key management, Template/model discovery, personal Agent and Session management,
and Realtime Model/Connection preparation for [service revision
b59a0a58](https://github.com/mem9-ai/agent-stack/commit/b59a0a584eb2632b8d9c6d0808b8ea26081b1474).

Turn execution and history exports remain for subsequent refresh slices; they
are **not verified or supported against this baseline**. Template version
application, Memory configuration, default Agents and general Agent overrides
are removed. This package remains a selective Node.js client; browser, MSP,
management and device APIs are outside this refresh.

## Quick start

Install the package built from this checkout. This change does not publish a new
npm release:

```sh
npm run build
npm pack --workspace @mem9/tidb-link
# In your application directory:
npm install /path/to/mem9-tidb-link-0.3.0.tgz
```

An application backend uses an Organization API Key (`ti_org_…`). The service
derives its Organization from that key; no Organization, User or Project selector
is accepted by this client.

```ts
import { OrganizationClient } from "@mem9/tidb-link";

const organization = new OrganizationClient({
  baseUrl: process.env.AGENT_SERVICE_URL!,
  apiKey: process.env.ORGANIZATION_API_KEY!,
});
const current = await organization.getOrganization();
const user = await organization.createEndUser({
  externalId: "your-application-user-id",
  displayName: "Customer",
});
const issued = await organization.createUserApiKey(user.userId, {
  name: "backend",
});
// Store user.userId in your application mapping and issued.token in your secret manager.
```

`externalId` is unique within the Organization. Creating it again returns
`ConflictError` with code `resource_conflict`; it does not return the existing
User. Use `listEndUsers()` and match `externalId` when finding an existing mapping
or reconciling an uncertain creation, then `getEndUser(userId)` to retrieve it.
These User and Key lists return complete arrays; this baseline has no pagination.
A request ID identifies a request for diagnosis and does not deduplicate creation.

The packaged example performs that lookup and reconciliation:

```js
import { provisionUser } from "@mem9/tidb-link/examples/provision-user.mjs";
const { organization, user, apiKey, token } = await provisionUser({
  baseUrl: process.env.AGENT_SERVICE_URL,
  organizationApiKey: process.env.ORGANIZATION_API_KEY,
  externalId: "your-application-user-id",
});
// Persist the mapping and token securely; never log token.
```

It can also run directly after setting `AGENT_SERVICE_URL`,
`ORGANIZATION_API_KEY`, `END_USER_EXTERNAL_ID`, and `USER_CREDENTIAL_FILE`:

```sh
node node_modules/@mem9/tidb-link/examples/provision-user.mjs
```

The CLI reserves a new private file before issuing a key and writes the result,
including the token, there. It refuses to overwrite an existing file. A failed
run can leave an empty file; inspect the failure before trying again. **Every
successful invocation issues a new key**, even for an existing User. Reuse the
stored credential during normal application startup.

## Key management

```ts
const keys = await organization.listUserApiKeys(user.userId);
const replacement = await organization.rotateUserApiKey(issued.apiKey.apiKeyId);
// Save replacement.token; the previous token immediately stops authenticating.
const revoked = await organization.revokeUserApiKey(issued.apiKey.apiKeyId);
```

Create and rotate return `{ apiKey, token }`. List and revoke return metadata
without the token or stored hash. Rotation preserves the key ID; revocation is
idempotent. Only active ordinary End Users can own keys. Missing, foreign or
disabled targets preserve the service's refusal.

The returned User API Key (`ti_user_…`) authenticates that User's public APIs.
It grants no Organization management authority; `OrganizationClient` rejects it.
An Organization key likewise grants no User identity.

## Templates, Agents and Sessions

Use a User API Key to discover available Templates and deployment models. Model
IDs are strings from the deployment catalog, including newly published models.
`effectiveDefaultModel` is the create-time default; `defaultModel` is the
service's canonical catalog default and may differ.

```ts
import { UserClient } from "@mem9/tidb-link";

const customer = new UserClient({
  baseUrl: process.env.AGENT_SERVICE_URL!,
  apiKey: process.env.USER_API_KEY!,
});
const page = await customer.listAgentTemplates({ limit: 20 });
const template = page.templates[0];
if (!template) throw new Error("Select an available Template");
const models = await customer.listModels();
const agent = await customer.createAgent({
  agentTemplateId: template.agentTemplateId,
  idempotencyKey: "customer-agent-1",
});
await agent.update({ additionalInstructions: "Prefer concise answers." });
const session = await agent.createSession({
  idempotencyKey: "customer-conversation-1",
  model: models.effectiveDefaultModel,
  billingTag: { key: "account", value: "customer-1" },
});
await session.rename("Planning");
await session.suggestName({ userText: "Plan a trip" }); // Generates and saves a name.
await session.setBillingTag(null);
```

Persist each creation key before calling. A new Agent key creates an independent
Agent even for the same Template; the same key and Template recover the original
Agent, including after unlinking. Reusing the key for another Template raises
`ConflictError` with `agent_creation_conflict`. Session creation likewise requires
a stable key and the same original input when recovering a creation. Its model,
Realtime Model and Billing Tag selections participate in that identity. Do not
generate a new key just because a response was lost.

`listAgentTemplates({ limit?, cursor? })` returns
`{ templates, hasMore, nextCursor }`; `listSessions({ limit?, cursor? })` returns
`{ sessions, hasMore, nextCursor }`, with `Session` handles in `sessions`.
Continue with the returned opaque cursor until `hasMore` is false, including
Template pages with no available entries. A changed Template catalog can refuse
continuation with `agent_template_list_changed`; restart discovery.
Session cursors belong to their owning User and list. `listAgents()` returns a
complete `Agent[]` without pagination. Use `getAgent(id)` and `getSession(id)` to
read current owned resources; `session(id)` creates a handle without a request.

Agent create/list responses contain association metadata. `getAgent`,
`agent.refresh()` and `agent.update()` also include `data.additionalInstructions`.
The service normalizes line endings to LF and trims whitespace, allows up to
4096 UTF-8 bytes after normalization, and rejects unsupported control characters.
Null or empty text clears the setting. Updates use last committed write wins,
without an ETag, and affect only future Sessions. Multiple Agents using the same
Template retain independent settings and Sessions.

Each Session freezes its Template recipe, digest and Agent preferences at
creation. Later Template saves and Agent updates do not rewrite it. Session
model selection is separate:

```ts
const current = await customer.getSession(session.id);
await current.setModel(models.effectiveDefaultModel);
// Another handle's intervening model change makes this handle stale.
// Refresh and make an explicit choice after a ConflictError (HTTP 412).
```

`setModel` uses the model ETag retained by the handle, reading it first if needed.
It never silently retries a stale update. Model changes apply to the next Turn;
active execution, steering and retry retain the model admitted for that Turn.
Realtime Model selection has its own independent revision token. Availability,
Organization policy, read-only Sessions and current ownership remain service
decisions. `session.delete()` updates and returns the Session handle; `.data` contains the deleted tombstone; later ordinary reads
and lists hide the Session. Active execution or a read-only Session can refuse
deletion. Name and Billing Tag changes do not change the frozen recipe.

Organization authority can explicitly unlink an Agent belonging to a target User:

```ts
const archived = await organization.unlinkAgent(user.userId, agent.id);
```

The returned association is archived. Unlinking retains existing Session
ownership, binding, configuration and history; it does not grant the Organization
access to the User's private Session content. The SDK's history methods remain
outside this slice's supported surface.

The packaged example completes discovery and creation without message execution:

```js
import { createSessionWorkflow } from "@mem9/tidb-link/examples/create-session.mjs";

const { agent, session } = await createSessionWorkflow({
  baseUrl: process.env.AGENT_SERVICE_URL,
  userApiKey: process.env.USER_API_KEY,
  agentCreationKey: process.env.AGENT_CREATION_KEY,
  sessionCreationKey: process.env.SESSION_CREATION_KEY,
  agentTemplateId: process.env.TEMPLATE_ID,
  model: process.env.MODEL_ID,
});
```

For direct execution, set `AGENT_SERVICE_URL`, `USER_API_KEY`,
`TEMPLATE_ID`, `AGENT_CREATION_KEY` and `SESSION_CREATION_KEY`; `MODEL_ID` is optional.
Select and persist the Template ID, optional model and both keys before calling.
The example also returns the current Template page and model catalog. If no model
was requested, it preserves omission so the service can recover the original
creation even after the deployment default changes.

## Realtime connection preparation

A backend can discover the published Realtime Models and prepare an existing
owned Session for a terminal. The SDK returns the one-time connect token but does
not open or implement the WebSocket transport.

```ts
import { UserClient } from "@mem9/tidb-link";

const user = new UserClient({
  baseUrl: process.env.AGENT_SERVICE_URL!,
  apiKey: process.env.USER_API_KEY!,
});
const catalog = await user.listRealtimeModels();
const session = user.session(process.env.SESSION_ID!);
const current = await session.getRealtimeModelSelection();
const selected = catalog.models.find((model) => model.available);
if (selected && selected.id !== current.model) {
  await session.setRealtimeModel(selected.id, { ifMatch: current.etag });
}
const prepared = await session.openRealtimeConnection({
  metadata: { terminal: "kiosk-1" },
});
// Hand prepared.websocketUrl, prepared.connectToken and
// prepared.connectTokenExpiresAt directly to the intended terminal.
```

`setRealtimeModel` requires the independent ETag returned by
`getRealtimeModelSelection`; a stale ETag raises `ConflictError` with code
`realtime_model_conflict`. A selection change applies to the next Realtime
Connection. A live connection keeps the model and provider identity frozen at
its admission. Model availability, Session voice eligibility, language support,
audio support and one-live-connection admission remain service decisions.

Use `getRealtimeConnection()` to inspect the newest connection,
`createRealtimeConnectToken()` to mint another one-time credential, and
`endRealtimeConnection()` to terminate it. Connect tokens expire at the returned
`connectTokenExpiresAt` and cannot be recovered from later reads. The SDK does
not cache them. Actual media transport, audio capture/playback, codecs, browser
support and device connections are outside this package slice.

The packaged example accepts an existing Session ID and never prints the token:

```js
import { prepareRealtimeConnection } from "@mem9/tidb-link/examples/prepare-realtime-connection.mjs";

const prepared = await prepareRealtimeConnection({
  baseUrl: process.env.AGENT_SERVICE_URL,
  userApiKey: process.env.USER_API_KEY,
  sessionId: process.env.SESSION_ID,
  realtimeModelId: process.env.REALTIME_MODEL_ID,
});
```

Set `AGENT_SERVICE_URL`, `USER_API_KEY`, and `SESSION_ID` to run the example
directly. `REALTIME_MODEL_ID` is optional.

## Errors and uncertain outcomes

Organization and refreshed Agent/Session lifecycle methods accept
`{ requestId?, signal? }` options; creation and list options include these fields.
`TiDBLinkApiError` preserves status, service code, request identity and details;
`ConflictError` preserves explicit 409/412 conflicts. The service's response
request identity takes precedence over the one sent.

Safe reads and keyed Agent/Session creation use bounded retries with the same
request identity and creation key. User creation, key issuance, preference and
Session updates, unlinking, deletion and Realtime mutations are never
automatically replayed. Disconnects, unusable success responses, HTTP 408 and
server failures during these mutations raise `OutcomeUnknownError`. For an HTTP failure, its
`cause` retains the `TiDBLinkApiError`. Repeating revoke is safe, but an ambiguous
failure still reports an unknown outcome. `AbortSignal` stops the local request;
after dispatch it does not establish whether a mutation happened. Redirects are
refused.

After uncertain User creation, list and match the original `externalId`.
After uncertain issuance or rotation, listing keys can confirm metadata but
**cannot recover the one-time token**. Reconcile metadata and explicitly revoke
any unwanted key before deciding whether to issue again. The provisioning
example never repeats an uncertain credential operation.

After uncertain Agent/Session creation, repeat the original input with the same
creation key. After an uncertain preference, name, tag or model update, read the
resource before deciding on another change. Unlinking and deletion can hide a
resource from ordinary reads, so a missing resource does not recover its original
mutation receipt.

After an uncertain Realtime Model update, read the selection again. After an
uncertain connection open or end, inspect the newest connection. An uncertain
connect-token response cannot recover that plaintext token; deliberately mint a
new token after reconciling the connection state.

## Compatibility and verification

`TIDB_LINK_PROVISIONING_REVISION` / `tidbLinkProvisioningRevision`,
`TIDB_LINK_LIFECYCLE_REVISION` / `tidbLinkLifecycleRevision` and
`TIDB_LINK_REALTIME_REVISION` / `tidbLinkRealtimeRevision` identify the exact
service revision above for their named slices. The matching
`tidbLinkProvisioningOpenApiSha256`, `tidbLinkLifecycleOpenApiSha256` and
`tidbLinkRealtimeOpenApiSha256` fields pin
that revision's `docs/openapi.yaml`. `TIDB_LINK_API_VERSION` remains `0.0.1`; the
version string alone does not establish compatibility. The verified scope is the
provisioning, Template/Agent/Session management and Realtime preparation described
here, not every retained export
or every public API.

`TIDB_LINK_REVISION` / `tidbLinkRevision` retain revision
`49f2bb3b7d194ada614cf9caa0a79f24e7aeba87` for the unrefreshed Turn/history
APIs. The existing immutable contract checks preserve evidence for that historical
surface; they do not certify it against the provisioning baseline. Run them with
`TIDB_LINK_CONTRACT=/path/to/contract npm run test:service-contract`, using the immutable artifact selected by this repository's CI workflow. It contains `openapi.json` and `metadata.json`.

`npm test` covers the simulated HTTP failure boundary and installs the actual
packed artifact in a clean ESM TypeScript consumer. To verify the packed SDK and
its examples against the real service, use the service's Node.js 26 runtime, install its
pinned dependencies, generate Prisma, build its Hardware contract and prepare its
current schema in a **dedicated test database**. See the selected service's
[current-schema setup](https://github.com/mem9-ai/agent-stack/blob/b59a0a584eb2632b8d9c6d0808b8ea26081b1474/docs/prisma-first-tidb-validation-and-rollout.md).

```sh
AGENT_SERVICE_ROOT=/path/to/agent-stack \
TEST_TIDB_DATABASE_URL=mysql://root@127.0.0.1:4000/tidb_link_sdk_test \
TIDB_SSL=off npm run test:service
```

This command requires a clean service checkout at the exact revision and resets
all rows in the selected test database before and after the run. It uses the
service's existing AppModule test fixture, genuine credentials, real TiDB and
controlled model dependencies. Fixtures prepare identities, Templates and eligible
Realtime Sessions; public SDK methods perform Template-to-Agent-to-Session
creation, ownership checks, lifecycle updates and Realtime operations.
The public Session projection exposes the frozen Template digest but hides stored
Agent preferences. Preference snapshots and active-Turn model freezing also rely
on the selected service's [existing persistence evidence](https://github.com/mem9-ai/agent-stack/blob/b59a0a584eb2632b8d9c6d0808b8ea26081b1474/test/product/sessions/sessions-withorgstore.tidb.spec.ts); SDK reads alone do not
prove those hidden values.
No production supplier credentials or WebSocket redemption are needed. A
mismatch or unavailable service fails this check instead of silently skipping it.
