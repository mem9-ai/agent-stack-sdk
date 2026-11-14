# `@tidblink/server`

Official TiDB Link SDK for backends, for Node.js 22.12 or newer. ESM only, with
TypeScript declarations and no runtime dependencies. It uses API Keys that must
stay on your backend; do not ship it to browsers or devices.

## Supported scope

This package supports Organization information, End User provisioning,
Template, Skill and Connector management, Connector callback verification,
Template/model discovery, Session management and Template switches,
text submission, steering, cancellation, checkpoint retry, original-result waiting,
continuous progress, Client Tools, Session connections over Backend Connections,
conversation history, file attachments,
Realtime Model/Connection preparation, prerecorded audio and User usage reads for [service revision
4305ef67](https://github.com/mem9-ai/agent-stack/commit/4305ef67daebf23c416badf806217a7c11dcef37).

Text commands return durable receipts independently of execution. Waiting reads the
original command's outcome. The service has no Agent: a Session is created
directly from an explicit Template, and there is no default Template. Browser, MSP, Console and device APIs are
outside this package. Every resource workflow uses an Organization API Key with
an explicitly selected End User; User API Keys are not supported.

## Quick start

Install an exact published version. Prereleases are on the `next` dist-tag:

```sh
npm install --save-exact @tidblink/server@next
```

An application backend uses its Organization API Key (`ti_org_…`) and explicitly
selects the ordinary End User with `organization.user(userId)`. The Key remains
the caller; the User owns the resources.

```js
import { randomUUID } from "node:crypto";
import { OrganizationClient } from "@tidblink/server";
import { createSessionWorkflow } from "@tidblink/server/examples/create-session.mjs";

const baseUrl = process.env.AGENT_SERVICE_URL;
const organizationApiKey = process.env.ORGANIZATION_API_KEY;
const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
const endUser = await organization.createEndUser({ externalId: "your-application-user-id" });
// Safe to repeat: the same externalId returns the same End User.
const user = organization.user(endUser.userId);
const page = await user.listAgentTemplates();
const template = page.templates[0];
if (!template) throw new Error("Select an available Template; follow nextCursor if hasMore");
const creation = {
  baseUrl, organizationApiKey, userId: endUser.userId,
  templateId: template.agentTemplateId,
  sessionCreationKey: randomUUID(),
};
// Persist the selected Template, optional model and the creation identity.
// Add acknowledgeSessionRecall: true when the Template enables cross-Session Recall.
const { session } = await createSessionWorkflow(creation);
const message = { clientEventId: randomUUID(), text: "Help me plan a trip" };
// Retain the Session, command identity and original input before dispatch.
const receipt = await session.submitMessage(message);
const result = await session.waitForResult(receipt.inputId);
console.log(result.text);
const recovered = await session.waitForResult(message.clientEventId);
```

`externalId` is unique within an Organization, and creation with it is
idempotent: a repeated `createEndUser` returns the existing End User unchanged and
does not apply the other fields, and concurrent calls create one End User. The SDK
retries such calls automatically. An `externalId` that equals an existing one only
when case and accents are ignored is refused with `resource_conflict`. Without an
`externalId`, every call creates a new End User. A Template that enables
cross-Session Recall refuses Session creation with
`agent_template_recall_acknowledgment_required` (HTTP 409) unless the input
includes `acknowledgeSessionRecall: true`. Session creation replays require the same creation key and
inputs. Reading the original message receipt or waiting again does not execute
another Turn. An HTTP request ID is diagnostic, not a creation identity.

The installed example can run with `AGENT_SERVICE_URL`,
`ORGANIZATION_API_KEY`, `END_USER_ID`, `TEMPLATE_ID` and
`SESSION_CREATION_KEY` (`MODEL_ID` and `ACKNOWLEDGE_SESSION_RECALL=true` are optional):

```sh
node node_modules/@tidblink/server/examples/create-session.mjs
```

`organization.user(userId)` returns an `EndUserClient` with that User's
Session, file and catalog methods. Selecting a User sends no request.
Usage reads stay on `organization.getUserUsage(userId, options)` and
`getUserUsageDetails`.
Private MCP registration, general Drive entry management, Template switching,
Schedulers and native Hardware APIs are not wrapped by this SDK. Use the
pinned public HTTP contract for those existing service capabilities. Building ToD,
a device gateway or management integration remains outside this package.
Artifact APIs remain gated. The SDK prepares Realtime HTTP grants; applications
own WebSocket/media transport. This change adds neither a generated full API
client nor a media client.

### Credential rotation

After Organization Key rotation or revocation, create a new `OrganizationClient`
with fresh valid authority and select the same User. Existing handles retain their
old credential. New old-authority requests, subscriptions,
Realtime tokens and Organization-issued file tickets lose authority. Accepted
Turns continue, and admitted file transfers may finish. Reconnect/obtain new
grants with fresh authority and reconcile the original command before submitting
new work. Another valid Key remains usable. Disabled Users cannot start new work;
Organization authority can still read retained history/files and perform supported
cleanup. Application policies and K3 spending policy are separate concerns.

### Custom transport

Pass `fetch` to route every request through your own transport, for example a
proxy, a custom HTTP agent, instrumentation or a test double. It carries all
requests the client makes: JSON calls, event streams, and file transfers to
presigned storage URLs (which never receive the API Key).

```js
const organization = new OrganizationClient({
  baseUrl,
  apiKey: organizationApiKey,
  fetch: (url, init) => fetch(url, { ...init, dispatcher: proxyAgent }),
});
```

## Managing Templates and Skills

A Template defines what a Session runs: its identity, instructions, Sandbox,
voice language, Skills and Connectors. `organization.templates` manages the Organization's Templates, and
`organization.skills` uploads and publishes the Skills they reference. Both act
on the Organization; they need no End User.

```js
const catalog = await organization.templates.catalog();
const created = await organization.templates.create({
  displayName: "Support assistant",
  content: {
    identity: { agentName: "Ava" },
    instructions: "Answer support questions briefly.",
    sandbox: { profileId: catalog.sandboxes[0].id },
    realtime: { language: "en-US" },
  },
  idempotencyKey: templateCreationKey,
});
// Replace and archive take the ETag you read; a stale one is a ConflictError.
await organization.templates.replace(created.template.id, { displayName, content }, {
  ifMatch: created.template.etag,
  idempotencyKey: templateChangeKey,
});
```

`templates.catalog()` lists the models, Sandbox profiles and published Skills a
Template may reference. `templates.list()` filters by `lifecycleStatus` and `q`
and pages with `cursor`. Replacing a Template does not change Sessions already
created from it; they keep the content snapshot identified by
`session.data.template.contentDigest`. An archived Template can no longer start
Sessions. Creation, replacement and archive are retried automatically with their
idempotency key; after an `OutcomeUnknownError`, repeat the call with the same key
and input.

A Skill is a ZIP package with a `SKILL.md` at its root. Uploading validates it
asynchronously; publishing makes it the Skill's next version:

```js
const upload = await organization.skills.upload({ bytes: zipBytes, idempotencyKey });
const validated = await organization.skills.waitForUpload(upload.uploadId);
if (validated.state !== "awaiting_confirmation")
  throw new Error(validated.validation.failureCode ?? validated.state);
await organization.skills.publish(upload.uploadId, { idempotencyKey: publishKey });
const published = await organization.skills.waitForUpload(upload.uploadId, { until: ["done", "failed"] });
// Reference it from a Template: content.skills = [{ skillId, version }]
const reference = { skillId: published.skillId, version: published.version };
```

Each upload creates a new Skill, and an upload is visible only to the Organization
API Key that created it. Publish before `expiresAt`, or cancel an unpublished
upload with `cancelUpload`. `skills.list()` and `skills.get(skillId)` read
published Skills and their versions.

## Connectors

A Connector is an Organization-owned MCP tool server that Sessions call. The
platform calls it for the End User who owns the Session and names that User in
every call, so your server can act on the right account without trusting model
arguments.

```js
let connector = await organization.connectors.register({
  displayName: "Orders",
  endpointUrl: "https://orders.example.com/mcp",
});
// Activation connects to the endpoint and discovers its tools.
connector = await organization.connectors.activate(connector.connectorId, {
  expectedConnectorVersion: connector.connectorVersion,
});
```

Edit (`update`) only an inactive Connector, and pass the `connectorVersion` you
read to every change; a stale one is a `ConflictError`. `deactivate` stops new
calls. Registration is not retried automatically: after an `OutcomeUnknownError`,
list the Connectors and match the display name, which is unique. Templates refer
to Connectors through Console tool settings; this SDK does not set them.

Your Connector verifies every request the platform sends (initialization, tool
discovery and tool calls) with `verifyConnectorCallback`, and reads who a tool
call is for with `readConnectorCallContext`:

```js
import { ConnectorKeySet, verifyConnectorCallback, readConnectorCallContext } from "@tidblink/server";

// Fetch keys only from your trusted deployment URL; they are cached.
const keys = new ConnectorKeySet({ baseUrl });
await verifyConnectorCallback(request.headers.authorization, {
  keys, organizationId, connectorId,
}); // Throws ConnectorAuthError: answer 401.
// For tools/call:
const { callId, userId, sessionId, deadline } = readConnectorCallContext(
  message.params._meta, { organizationId },
);
```

Tokens are Ed25519-signed, valid for at most 60 seconds, scoped to your
Organization and Connector, and may be reused within that scope. Deduplicate side
effects by `callId`; the platform never retries a call (`attempt` is always 1).
Abandon work after `deadline`. The packaged `http-connector.mjs` example is a
complete Connector over Streamable HTTP without an MCP library. The model sees each
tool as `mcp_<server name>__<tool>`. This SDK does not include a client for the
`tunnel` transport.

## Templates and Sessions

Use `organization.user(userId)` to discover available Templates and deployment models. Model
IDs are strings from the deployment catalog, including newly published models.
`effectiveDefaultModel` is the create-time default; `defaultModel` is the
service's canonical catalog default and may differ.

```ts
import { OrganizationClient } from "@tidblink/server";

const organization = new OrganizationClient({
  baseUrl: process.env.AGENT_SERVICE_URL!,
  apiKey: process.env.ORGANIZATION_API_KEY!,
});
const customer = organization.user(process.env.END_USER_ID!);
const page = await customer.listAgentTemplates({ limit: 20 });
const template = page.templates[0];
if (!template) throw new Error("Select an available Template");
const models = await customer.listModels();
const session = await customer.createSession({
  templateId: template.agentTemplateId,
  idempotencyKey: "customer-conversation-1",
  model: models.effectiveDefaultModel,
  billingTag: { key: "account", value: "customer-1" },
  additionalInstructions: "Prefer concise answers.",
  sandbox: { workingDirectory: "projects/trip" },
});
await session.rename("Planning");
await session.suggestName({ userText: "Plan a trip" }); // Generates and saves a name.
await session.setBillingTag(null);
```

`createSession` requires `templateId`, an active Template of the Organization;
there is no default Template. The other options belong to this Session only:

- `additionalInstructions` are added to the Template instructions. The service
  normalizes line endings to LF and trims whitespace, allows up to 4096 UTF-8
  bytes after normalization, and rejects unsupported control characters. The
  Template and additional instructions together are limited to 16 KiB
  (`agent_instructions_too_large`).
- `sandbox.profileId` selects a Sandbox profile; omit it or pass `null` to use
  the Template's profile. `sandbox.workingDirectory` is a Drive-relative
  directory and defaults to `.`; creating the Session does not create it.
- `acknowledgeSessionRecall: true` is required when the Template enables
  cross-Session Recall, which can read other Sessions of the same End User;
  otherwise creation fails with `agent_template_recall_acknowledgment_required`.
- `model`, `realtimeModel`, `billingTag` and Client Tool `tools` work as
  described in their own sections.

Persist the creation key before calling. The same key and the same input recover
the original Session; reusing the key with different input raises
`ConflictError` with `session_creation_conflict`. Every option participates in
that identity. Do not generate a new key just because a response was lost.

`listAgentTemplates({ limit?, cursor? })` returns
`{ templates, hasMore, nextCursor }`; `listSessions({ limit?, cursor?, templateId? })`
returns `{ sessions, hasMore, nextCursor }`, with `Session` handles in `sessions`.
`templateId` lists only Sessions currently on that Template; keep the same
`templateId` when following a cursor.
Continue with the returned opaque cursor until `hasMore` is false, including
Template pages with no available entries. A changed Template catalog can refuse
continuation with `agent_template_list_changed`; restart discovery.
Session cursors belong to their owning User and list. Use `getSession(id)` to
read a current owned Session; `session(id)` creates a handle without a request.

Each Session freezes its Template recipe, digest and creation options.
Later Template saves do not rewrite it; `session.data.template` names the
Template and digest in use. Only an explicit
[Template switch](#switching-a-sessions-template) moves it to a Template's
current content. Session model selection is separate:

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

The packaged example completes discovery and creation without message execution:

```js
import { createSessionWorkflow } from "@tidblink/server/examples/create-session.mjs";

const { session } = await createSessionWorkflow({
  baseUrl: process.env.AGENT_SERVICE_URL,
  organizationApiKey: process.env.ORGANIZATION_API_KEY,
  userId: process.env.END_USER_ID,
  sessionCreationKey: process.env.SESSION_CREATION_KEY,
  templateId: process.env.TEMPLATE_ID,
  model: process.env.MODEL_ID,
});
```

For direct execution, set `AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY`, `END_USER_ID`,
`TEMPLATE_ID` and `SESSION_CREATION_KEY`; `MODEL_ID` and
`ACKNOWLEDGE_SESSION_RECALL=true` are optional. The workflow also passes
`additionalInstructions`, `sandbox` and `acknowledgeSessionRecall` through.
Select and persist the Template ID, optional model and the key before calling.
The example also returns the current Template page and model catalog. If no model
was requested, it preserves omission so the service can recover the original
creation even after the deployment default changes.

### Switching a Session's Template

`session.switchTemplate()` moves a Session to another active Template's current
content. Switching to the Template the Session is already on also applies that
Template's latest saved content. Persist a key per switch, as for creation:

```ts
const receipt = await session.switchTemplate({
  templateId: nextTemplateId,
  idempotencyKey: switchKey,
  // acknowledgeSessionRecall: true, when the target enables cross-Session Recall
});
if (receipt.status === "pending") {
  const handoff = await session.getTurn(receipt.handoffTurnId);
  if (handoff.status !== "running") await session.refresh();
} else if (receipt.status === "failed") {
  console.warn(receipt.error.code);
}
```

| `status` | Meaning |
| --- | --- |
| `unchanged` | The target's content equals the current configuration; nothing changed and no `handoffTurnId` |
| `succeeded` | The Session is on the target at the receipt's `configurationEpoch`. A first response says this only when the Session had no history, so no Handoff ran |
| `pending` | The Session has history, so the Handoff Turn `handoffTurnId` runs under the target Template |

A `pending` switch settles when its Handoff Turn does: the Session moves to the
target, or the switch fails and the Session stays on its previous Template.
Follow it like any Turn, with `session.getTurn(receipt.handoffTurnId)` or the
event stream, which reports `agent.session.template_switch.succeeded` or
`.failed`. `session.refresh()` then shows the new `template` and
`configurationEpoch`, and `switching` is `false` once it has settled. The receipt
holds no Session, so `switchTemplate()` never updates `session.data`; call
`refresh()`. While a switch is pending, new messages and another switch are
refused with `session_switch_in_progress`.

The service refuses a switch it does not record:

| Error | Cause |
| --- | --- |
| `ConflictError` `session_switch_busy` | A Turn is running or a Realtime Connection is live |
| `ConflictError` `session_switch_in_progress` | Another switch has not settled |
| `ConflictError` `agent_template_recall_acknowledgment_required` | The target enables cross-Session Recall; pass `acknowledgeSessionRecall: true` |
| `ConflictError` `session_read_only` | The Session cannot change Template, such as a Template Test Session |
| `ConflictError` `resource_conflict` | The target's Realtime language is no longer offered, or state changed during admission |
| `ConflictError` `idempotency_key_reused` | The key was used with a different Session, Template or acknowledgment |
| `TiDBLinkApiError` 404 `agent_template_unavailable` | The target is archived, missing or its dependencies are unusable |
| `TiDBLinkApiError` 404 `session_not_found` | The Session or its owner is unavailable |
| `TiDBLinkApiError` 503 `turn_admission_closed`, `skill_package_store_unavailable` | Temporarily unavailable; retry later |

After a lost response (`OutcomeUnknownError`), repeat the call with the same key
and input to recover the receipt; the service returns the command's latest
receipt and records no second switch. Do not poll this way. Commands belong to
the Organization API Key that sent them, so recover with the same key; after a
rotation, follow the Session instead. A replay after the Session is deleted or
its owner loses access is refused with `session_not_found`.

The Handoff Turn summarizes the Session so far for the target Template. History
reads return it as a Turn with `kind: "template_handoff"`, no `userMessage` and
an empty `userMessages`; when it succeeds, its assistant Message is the summary.
The service's
[ADR 0107](https://github.com/mem9-ai/agent-stack/blob/4305ef67daebf23c416badf806217a7c11dcef37/docs/adr/0107-switch-session-template-baselines-through-configuration-epochs.md)
describes what the Session keeps across a switch (models, Billing Tag, Client
Tools and creation options) and that cancelling the Handoff Turn fails the
switch.

## Text messages and original results

Persist the Session ID, command identity and complete input before dispatch.
`clientEventId` is required, Session-local, and contains 1–128 safe characters
(letters, digits, `_`, `.`, `:`, `-`, starting with a letter or digit). It is
separate from the diagnostic HTTP `requestId`.

```ts
const session = customer.session(savedSessionId);
const input = { clientEventId: savedCommandId, text: "Plan the trip" };
const receipt = await session.submitMessage(input);
// Accepted does not mean incorporated or completed.
const result = await session.waitForResult(receipt.inputId, {
  timeoutMs: 60_000,
  pollIntervalMs: 250,
});
console.log(result.text);
// Or submit once and wait: await session.turn(input, { timeoutMs: 60_000 });
```

`submitMessage` returns the service's `SessionInteraction`. `mode` distinguishes
started or steered work from refused inputs; `appliedAt` records actual
incorporation. `result.status` and `result.completedAt` belong to the original
execution generation, even after an explicit retry. A running Turn can accept
another message; each message needs its own identity and incorporation status.
The same identity and input recover its original receipt. A conflicting reuse
raises `ConflictError` with `interaction_input_conflict`.

Text accepts a string or a nonempty ordered array of up to nine strings for
clarification answers. `clarificationSourceTurnId` links a saved Clarification
Item. Optional `billingTag` (including null) and ready `userFileIds` are passed
through; use [file attachments](#file-attachments) to upload and verify them.
Successful `TurnResult`
contains the original `inputId`, `sessionId`, `turnId`, saved `messageId`, `text`
and `interaction`; a clarification additionally contains `clarification`.
Drafts, Session idleness, EOF and acceptance never establish success.

`waitForResult` reads receipts and the matching saved successful Turn. Its default
local deadline is 60 seconds; `pollIntervalMs` defaults to 250 milliseconds.
`TurnWaitTimeoutError` and an aborted wait (`OutcomeUnknownError`) retain
`sessionId`, `inputId`, any known `turnId`, and the HTTP request ID when available.
Neither cancels, resubmits or changes the command. `TurnFailedError` and
`TurnInterruptedError` retain the original command and Turn identity; failure
uses `turn_failed`, since a later Turn read could describe a different generation.
A refused or successful-but-unincorporated message raises `InputNotAppliedError`.
Read its receipt to inspect the original fact.

A disconnect, malformed success response, HTTP 408 or server failure during
submission raises `OutcomeUnknownError` with the original recoverable identity.
The SDK never automatically repeats text submission. Reconcile explicitly:

```ts
const original = await session.reconcileInteraction(savedCommandId);
// null means no receipt was visible at this read; an in-flight request may still arrive.
if (original) {
  const result = await session.waitForResult(savedCommandId);
}
// getInteraction(savedCommandId) returns the receipt, or interaction_not_found (404).
```

Keep the original input identity when deliberately repeating a submission; the
service deduplicates it. Generating another identity can execute the effects
again. `AbortSignal` before dispatch stops submission; after dispatch it cannot
establish whether the command was accepted.

The packaged example uses an existing owned Session and a caller-retained input:

```js
import { sendMessageWorkflow } from "@tidblink/server/examples/send-message.mjs";
const result = await sendMessageWorkflow({
  baseUrl: process.env.AGENT_SERVICE_URL,
  organizationApiKey: process.env.ORGANIZATION_API_KEY,
  userId: process.env.END_USER_ID,
  sessionId: process.env.SESSION_ID,
  clientEventId: process.env.CLIENT_EVENT_ID,
  text: process.env.MESSAGE_TEXT,
});
```

Set those five environment variables to run the installed example directly:
`node node_modules/@tidblink/server/examples/send-message.mjs`. It prints only the
final answer. Preserve the input across invocations; each new command identity
can start new work. This slice replaces the obsolete response-owned NDJSON
`streamTurn` API. Use the independent progress subscription below.

## Progress and Session events

Progress and events reach the application over a Session connection, not over
a per-Session stream: `conn.send(text, { onProgress })` reports a message's draft,
and `session.connect({ onEvent, cursor, onCursor })` follows every event of the
Session with a resumable cursor (see [Connecting a Session](#connecting-a-session)).
`waitForResult(inputId)` and `turn()` stay available over plain HTTP for a
process that keeps no connection, for example to recover a result after a restart.

`asKnownSessionEvent(event)` narrows an event to the types the SDK knows: Turn
lifecycle, drafts, progress, saved messages and Operation steps, Client Tool
calls, Realtime transcripts and responses, Template switches and
`agent.session.idle`. It returns `undefined` for anything else, which is still
delivered unchanged. A draft (`agent.session.turn.output_text.snapshot`) is a
complete snapshot: replace what you showed, including with an empty reset.

## Connecting a Session

`session.connect()` attaches a Session to this process's Backend Connection, one
WebSocket per Application Server process to the core (ADR 0109 of the service).
It is meant for a backend that stays attached to a Session, for example while
the user's device is online: it receives the Session's events, and it declares
and executes the Session's Client Tools. Each connection is one row in the
core and costs no polling, so attach when the device comes online.

```ts
const conn = await organization.user(userId).session(sessionId).connect({
  tools: lampTools(deviceId),                 // see below
  cursor: await db.getCursor(deviceId),       // resume after a restart
  onCursor: (cursor) => db.saveCursor(deviceId, cursor),
  onTranscript: (t) => app.push(deviceId, { role: "user", text: t.text }),
  onResponse: (r) => app.push(deviceId, { role: "assistant", text: r.text }),
  onEvent: (event) => forward(event),         // every event, in order
});
conn.closed.then((end) => console.log("connection ended", end.reason));
// ...when the device goes offline:
await conn.close();
```

- **Events.** Callbacks run one event at a time, in the Session's order, and
  `onCursor` follows once an event's callbacks have completed. Persist that
  cursor and pass it back as `cursor` to replay what was missed; without one,
  delivery starts after the Session's latest event and history is not replayed.
  `onTranscript` and `onResponse` receive completed Realtime transcripts and
  responses; `onEvent` receives every event, including types the SDK does not
  know.
- **Reconnection.** The SDK opens Backend Connections on demand, holds up to the
  `maxSessions` the core announces on each (1024 today) and opens another when
  one is full. After a lost connection, or when the core asks a connection to
  drain before a restart, it re-attaches each Session on another connection from
  the last processed event, without gaps or repeats. A connection that holds
  nothing closes after a few seconds. Liveness is checked with an application
  `ping` when a connection is silent.
- **One executor per Session.** A connection attaches for execution by default.
  Another process's connection to the same Session takes it over, and this one
  ends with `closed` resolving `{ reason: "superseded" }`. One `OrganizationClient`
  holds at most one connection per Session; reuse it. `observe: true` attaches
  for events only, never takes the Session over and cannot declare tools.
- **Ends.** `closed` resolves once: `closed` after `close()` or
  `organization.close()`, `superseded`, `session_deleted`, or `error` when the
  connection cannot be restored, for example after the Organization API Key was
  revoked (a `BackendConnectionClosedError` with code 4001). A refused attach
  rejects `connect()` with a `BackendRequestError` whose `reason` is the core's,
  such as `session_not_found`.
- **Errors in your callbacks** do not stop delivery. They go to `onError`;
  without it they are rethrown asynchronously, which by default ends a Node.js
  process.

### Client Tools on a connection

`tools` maps each Client Tool name to its declaration and a `run` function. Each
attach replaces the Session's whole Client Tool set with these declarations, and
the connection executes their calls:

```ts
const lampTools = (deviceId: string): ClientToolHandlers => ({
  set_light: {
    description: "Turn the lamp on or off, or set its brightness",
    parameters: {
      type: "object",
      properties: {
        on: { type: "boolean" },
        brightness: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    run: async (args, { signal }) => {
      // Fail at once when the device is offline, so the model does not wait.
      const state = await askDevice(deviceId, "set_light", args, { signal });
      return state.on ? `On at ${state.brightness}%` : "Off";
    },
  },
});
```

- **Claim before running.** For each call the SDK first asks the core for the
  right to execute it and runs `run` only when the core grants it, so a call the
  core reports as not performed was never executed. A call that nobody claims
  within the core's claim window (5 seconds) is reported to the model as not
  performed.
- **Results.** A returned string is what the model receives; other values are
  sent as JSON. A thrown error becomes a failure whose message the model sees.
  A tool the connection has no handler for fails with a message saying so.
  Results go back over any Backend Connection of the Organization and are
  retried after a lost connection until the call's deadline.
- **Once per call.** A `callId` runs at most once per connection, even when the
  core sends it again after a reconnect. If the core's answer to a claim is
  lost, the SDK does not run the call and closes it as failed.
- **Deadline.** `run` receives `{ callId, sessionId, userId, turnId, name,
  deadlineAt, signal }`. At `deadlineAt`, 60 seconds after the call was
  published, `signal` aborts and the SDK reports a timeout; the core then tells
  the model the effect is unknown.
- **After `close()`** calls already running finish and their results are still
  submitted; later calls are not received.

A result the core does not accept, for example after the call's deadline,
reaches `onError` as a `ClientToolResultRefusedError` with the core's `reason`.
Calls are answered only on the executing connection; the `claimBy` they carry in
`requires_action` events marks them as such.

### Messages and voice on a connection

`conn.send(text, options)` sends a user message over the connection and resolves
with the same result as `session.turn()`, once the Turn finishes:

```ts
const reply = await conn.send(text, {
  clientEventId: savedMessageId,              // optional; persist it to recover after a crash
  onProgress: (draft) => app.show(deviceId, draft),
});
return reply.text;
```

- The message starts a Turn on an idle Session or steers the active one; the
  call waits for that Turn either way. Rejections, failures, interruptions and
  local timeouts raise the same errors as `session.turn()`: `InputNotAppliedError`,
  `TurnFailedError`, `TurnInterruptedError` and `TurnWaitTimeoutError` (default
  `timeoutMs` 60 seconds, which never cancels the Turn).
- The call resolves once the Session has also released the Turn
  (`agent.session.idle`), so the next `send()`, audio Turn or Template switch
  starts at once instead of steering a finished Turn or being refused as busy.
  The release normally follows the result at once; after 5 seconds without it
  the result is returned anyway.
- Progress comes from the pushed events, without polling. `onProgress` receives
  the complete draft each time it grows (today every 1,024 characters): replace
  what you showed, do not append. When the Turn finishes, the SDK reads the
  settled result once over REST.
- `clientEventId` shares the Session's command namespace with REST. Without
  one the SDK generates a UUID. If a reconnect loses the core's answer, the SDK
  sends the message again with the same `clientEventId`, which the core
  deduplicates; if it cannot, the call raises `OutcomeUnknownError` with
  `inputId`, and `session.waitForResult(inputId)` recovers the result.
- A refusal of the message command, such as `session_read_only` or
  `turn_admission_closed`, raises `BackendRequestError` with that code as
  `reason` and the REST `details`.

`conn.realtimeGrant({ audio?, metadata? })` prepares the Session's Realtime
connection and returns `{ websocketUrl, connectToken, connectTokenExpiresAt }`
for a device to join it directly. When a Realtime connection is already live it
returns a new token for that one, and `audio` is not applied. The token is short
lived; ask for a new grant each time the device wants to talk.

The connection uses the global `WebSocket` of Node.js 22, which sends the
Organization API Key in the upgrade's `Authorization` header and never in the
URL. Pass `WebSocket` to `OrganizationClient` to use another implementation; it
must accept `new WebSocket(url, { protocols, headers })`.

## Session Client Tools

Declare the application functions that a Turn may request. `connect({ tools })`
declares them on every attach; the REST methods below read or replace the set
without a connection. Parameters are JSON Schema objects. The service validates reserved
names, schema size/depth and combined tool limits; the `async` argument is reserved
for the platform and is not part of application arguments.

```ts
import type { ClientToolDeclaration } from "@tidblink/server";
const tools: ClientToolDeclaration[] = [{
  type: "function",
  name: "lookup_order",
  description: "Read an order status",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
}];
const session = await customer.createSession({
  templateId: savedTemplateId,
  idempotencyKey: savedSessionCreationKey,
  tools,
});
const current = await session.getClientTools();
await session.replaceClientTools(tools, { ifMatch: current.etag });
```

Replacement is the complete set, with `[]` clearing it. Its ETag is independent of
the Session's model ETag. Stale replacement returns `precondition_failed`; read the
set and decide again. A Turn retains the declarations admitted when it started.
An identical replacement keeps its revision. Text, voice and prerecorded-audio Turns
use the Session's declarations; Scheduler-started Turns do not.

An executing Session connection runs the calls of these tools; see
[Client Tools on a connection](#client-tools-on-a-connection). There is no REST
path to answer a call.

## Saved conversation history

```ts
const interactions = await session.listInteractions({ limit: 20 });
const turns = await session.history({ limit: 20 });
const turn = await session.getTurn(result.turnId);
const timeline = await session.timeline({ limit: 20 });
```

Each list returns its named array (`interactions`, `turns`, or `entries`) and
`hasMore` / `nextCursor`. Limits are 1–200, default 50. Continue with the opaque
cursor in the same User, Session and list; the SDK does not silently flatten or
refetch pages. Interactions are in ascending Session-local sequence. Turns are
in creation-time order and preserve Full Agent and user-input Realtime
projections, including input context, saved multiple user Messages, Operations,
failure details and interrupted speech metadata. Narration-only Realtime facts
remain in Timeline and associated `realtimeResponses` rather than independent
public Turns.

Timeline combines Turn snapshots and durable Realtime facts in event order. A
Turn moved behind the Realtime input that started it can appear again after a
cursor; replace entries by Turn ID or Realtime fact ID. Late Realtime facts can
precede an already consumed Turn-list cursor; refresh Turn history or use
Timeline for durable ordering. History is readable content, not authority for an
original request's result: use its interaction receipt for that outcome.

## Steering, cancellation and checkpoint retry

Send another `submitMessage` while a Turn is active to add requirements. Its
receipt reports `mode: "steered"` and the same `turnId`; `appliedAt` records actual
incorporation. This is the service's ordinary message admission, so a message
arriving after completion may start a new Turn. No target-locked steering command
is offered by this service. Inspect the receipt rather than assuming which Turn
accepted the message.

Cancellation targets an exact Turn and has its own stable command identity:

```ts
const stop = await session.cancel({
  clientEventId: savedCancellationId,
  turnId: original.turnId,
});
const cancellation = await session.getInteraction(stop.inputId);
```

Acceptance requests a stop; it does not establish termination or undo completed
effects. Read the cancellation receipt or the original message receipt until its
`result.status` is terminal. A completed Turn can retain success if completion won
the race. A stale target is refused rather than cancelling its successor.

Checkpoint retry deliberately starts another execution of the selected Turn:

```ts
const retry = await session.retry({
  clientEventId: savedRetryId,
  turnId: original.turnId,
});
const retried = await session.waitForResult(retry.clientEventId);
const earlier = await session.getInteraction(original.inputId);
```

The retry acceptance contains `{clientEventId, sessionId, turnId, disposition:
"retrying"}`. Its durable interaction is readable using `clientEventId`, including
through `reconcileInteraction`. Waiting accepts message and retry identities; a
successful saved answer must match that interaction's execution completion time.
Earlier failed or interrupted receipts keep their original outcome even when the
Turn later succeeds. A cancellation receipt is not an answer receipt.

Retry is disabled by default in Agent Service. `checkpoint_runtime_unavailable`
and other eligibility or authority refusals remain `TiDBLinkApiError`; the SDK
never substitutes a new message. An uncertain cancellation or retry preserves its
Session, command and Turn IDs in `OutcomeUnknownError`. Read the original receipt
before deciding whether to repeat the identical command. A new ID is a new
request, not network recovery.

The installed `@tidblink/server/examples/control-turn.mjs` exports
`controlTurnWorkflow`. It returns cancellation acceptance for `action: "cancel"`
and waits for the separate retry result for `action: "retry"`. Run it with
`AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY`, `END_USER_ID`, `SESSION_ID`, `TURN_ID`, `CLIENT_EVENT_ID` and
`TURN_ACTION` set; retain those identities before dispatch. This example never
chooses to retry automatically.

## Realtime connection preparation

A backend can discover the published Realtime Models and prepare an existing
owned Session for a terminal. The SDK returns the one-time connect token but does
not open or implement the WebSocket transport.

```ts
import { OrganizationClient } from "@tidblink/server";

const user = new OrganizationClient({
  baseUrl: process.env.AGENT_SERVICE_URL!,
  apiKey: process.env.ORGANIZATION_API_KEY!,
}).user(process.env.END_USER_ID!);
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
import { prepareRealtimeConnection } from "@tidblink/server/examples/prepare-realtime-connection.mjs";

const prepared = await prepareRealtimeConnection({
  baseUrl: process.env.AGENT_SERVICE_URL,
  organizationApiKey: process.env.ORGANIZATION_API_KEY,
  userId: process.env.END_USER_ID,
  sessionId: process.env.SESSION_ID,
  realtimeModelId: process.env.REALTIME_MODEL_ID,
});
```

Set `AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY`, `END_USER_ID`, and `SESSION_ID` to run the example
directly. `REALTIME_MODEL_ID` is optional.

## Prerecorded audio

An existing Session can accept a recording through its separate audio entry point.
The SDK sends multipart bytes and consumes that request's own response:

```ts
import { readFile } from "node:fs/promises";

const result = await session.audio({
  bytes: await readFile("recording.wav"),
  filename: "recording.wav",
  contentType: "audio/wav",
  billingTag: null,
});
console.log(result.text);
```

Supported recordings are mp3, mp4, mpeg, mpga, m4a, wav and webm. The request must
contain nonempty bytes no larger than 25 MiB. Transcription availability, codec
validity, budget and Session eligibility remain service decisions. Omit
`billingTag` to inherit the Session default, supply one key/value pair to override,
or use `null` to clear it for this Turn. The SDK encodes that optional field as
JSON without changing the file's bytes.

`audio()` returns an `AudioTurnResult` only after the same Turn emits its final
Message and successful terminal event. It throws `TurnFailedError` or
`TurnInterruptedError` for those terminal outcomes. `streamAudio()` exposes the
actual `AudioTurnEvent` sequence: `event`, `sessionId`, `turnId`, `seq`,
`createdAt`, optional `agentRunId`, and event-specific `payload`. An
`assistant_draft` contains a complete replacement snapshot, including an empty
reset; it is separate from `progress` and the final `assistant_message`.

**The audio request owns execution's response.** Breaking its event loop, aborting
its signal or losing the connection may request interruption. This differs from
closing a text observation subscription. EOF alone is never reported as success.
`AudioTurnStoppedError` preserves the Session and any already observed Turn ID;
inspect `getTurn(turnId)` or saved history before deciding what to submit next.
Audio accepts no `clientEventId`, has no ordinary text interaction receipt and
provides no idempotent resubmission or event-position recovery promise. The SDK
does not resubmit a recording automatically. A transcription refusal may still
have consumed provider work; it does not imply a refunded charge.

The installed `submit-audio.mjs` example reads an existing file and prints the
final answer. Set `AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY`, `END_USER_ID`, `SESSION_ID` and
`AUDIO_FILE_PATH`; `AUDIO_CONTENT_TYPE` is optional:

```sh
node node_modules/@tidblink/server/examples/submit-audio.mjs
```

The exported `submitAudioWorkflow()` accepts bytes and an optional abort signal.
This SDK does not capture, play, encode or bridge audio.

## File attachments

`user.files` manages owned uploaded files. Upload from a `Uint8Array` (including
Node.js `Buffer`) and retain a stable creation key with the exact bytes and name.
The service chooses inline or multipart transfer; the SDK supplies complete and
per-part SHA-256 digests, transfers the required bytes, and confirms whole-file
verification before returning a ready file. Empty files are supported.

```ts
import { readFile } from "node:fs/promises";

const file = await customer.files.upload({
  originalName: "notes.txt",
  bytes: await readFile("notes.txt"),
  contentType: "text/plain",
  idempotencyKey: savedUploadKey,
});
const result = await session.turn({
  clientEventId: savedMessageId,
  text: "Summarize the attached notes.",
  userFileIds: [file.fileId],
});
const downloaded = await customer.files.download(file.fileId);
```

Only ready files authorized for the Session's User may be attached. The service
checks that authority at message admission; an earlier local readiness check
cannot grant access to another User's file. File bytes remain separate from the
message text. `capabilities()` exposes current upload limits; a typed 413 requires
reading them again and explicitly deciding whether to create another upload.

For explicit recovery use `createUpload()` with the original metadata and key,
`getUpload(uploadId)`, `uploadContent()`, `presignPart()` / `uploadPart()`,
`completeUpload()`, and `cancelUpload()`. Retain each returned part number, ETag
and digest until completion. A status read never creates or transfers anything.
Create replay retains the original file and fixed upload expiry; it may renew a
short-lived inline transfer URL. An expired or failed upload requires a new key
and file. The SDK never chooses that new identity or repeats a failed transfer
automatically.

`FileUploadOutcomeUnknownError` carries `idempotencyKey` and, once creation was
acknowledged, `uploadId`. Read that upload before deciding what to repeat. A lost
creation response can be reconciled with `createUpload()` using the exact
original metadata and key. A pending multipart part can be signed again for its
original digest; after an uncertain completion, read status rather than assuming
failure or sending the message. Cancellation marks the incomplete file unusable;
it does not delete a previously accepted conversation.

`list({ history, limit, cursor })` returns `{ files, nextCursor }`; it has no
`hasMore` field. `get(fileId)` reads metadata. `getContent(fileId)` returns either
`{ type: "bytes", bytes, contentType }` or, for a large file,
`{ type: "download", grant }`. `downloadFromGrant(grant)` redeems the latter;
`download(fileId)` handles both forms and verifies complete size and SHA-256.
A new authorized content read obtains a fresh grant after expiry. Upload and
download grants are bearer credentials: do not log or store their URLs beyond
need. Transfers send only the grant's required headers, never an API Key.
Uploads reject redirects; a download may follow one HTTPS redirect without an
API Key. Files are held in memory while hashing or downloading, so size your
backend's concurrency for the service's advertised maximum.

The packaged `upload-file.mjs` example uploads and attaches one file. Set
`AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY`, `END_USER_ID`, `SESSION_ID`, `FILE_PATH`,
`UPLOAD_IDEMPOTENCY_KEY`, and `CLIENT_EVENT_ID`, then run:

```sh
node node_modules/@tidblink/server/examples/upload-file.mjs
```

The example returns the final conversation result; its exported
`uploadFileWorkflow()` accepts bytes directly. It does not manage general Drive
directories or write Session text files. Organization owner-scoped clients can
upload, read and attach the same ordinary Files.

## Errors and uncertain outcomes

Organization, text/progress/history and Session lifecycle methods accept
`{ requestId?, signal? }` options; creation and list options include these fields.
`TiDBLinkApiError` preserves status, service code, request identity and details;
`ConflictError` preserves explicit 409/412 conflicts. The service's response
request identity takes precedence over the one sent.

Safe reads, keyed Session creation and Template switches use bounded retries
with the same request identity and key. User creation,
Session updates, deletion and Realtime mutations are never
automatically replayed. Disconnects, unusable success responses, HTTP 408 and
server failures during these mutations raise `OutcomeUnknownError`. For an HTTP failure, its
`cause` retains the `TiDBLinkApiError`. `AbortSignal` stops the local request;
after dispatch it does not establish whether a mutation happened. Redirects are
refused.

After uncertain End User creation, repeat it with the same `externalId`.

After uncertain Session creation or Template switch, repeat the original input
with the same key. After an uncertain name, tag or model update, read the
resource before deciding on another change. Deletion can hide a
resource from ordinary reads, so a missing resource does not recover its original
mutation receipt.

After an uncertain Realtime Model update, read the selection again. After an
uncertain connection open or end, inspect the newest connection. An uncertain
connect-token response cannot recover that plaintext token; deliberately mint a
new token after reconciling the connection state.

## User usage

`organization.getUserUsage(userId, options)` and
`organization.getUserUsageDetails(userId, options)` read one target User's usage.

| | |
| --- | --- |
| Range | Required exact UTC timestamps with milliseconds, inclusive `from` and exclusive `to`; at most 31 days |
| Buckets | `interval: "hour"`, `"day"`, `"week"` or `"month"` |
| Details | Globally ordered `items`; optional `kind`, `limit` (1 to 500) and opaque `cursor`; `nextCursor: null` ends the stream |

Both support an exact `tagKey`/`tagValue` pair. Send both or neither. Values retain
case sensitivity and the service's normalization rules. Both also accept
`templateId`, which keeps only usage admitted under that Template; each detail
item reports it as `agentTemplateId`. Preserve the original range, kind, Template
and tag filters when following a cursor.

```ts
const page = await organization.getUserUsageDetails(targetUserId, {
  from: "2030-01-02T00:00:00.000Z",
  to: "2030-01-03T00:00:00.000Z",
  limit: 100,
});
```

The SDK returns the service's values unchanged. `costMicros: null`,
`pricingStatus: "unknown"`, `valuationStatus: "unpriced"`, and incomplete fact or
valuation counts retain different meanings. A stored numeric cost does not make
an unpriced fact billable. Priced totals exclude unpriced facts. Scalar cost totals describe platform-borne
costs; `costByBearer` preserves the separate platform, customer and unknown
categories. Public-list estimates are not supplier invoices or known final charges. Fact completeness and
valuation completeness are independent. Do not display missing costs as zero or
infer a balance from these reads.

The installed example `@tidblink/server/examples/read-usage.mjs` exports
`readUserUsage`, returning a summary and the first detail page. The CLI requires
`AGENT_SERVICE_URL`, `ORGANIZATION_API_KEY` and `END_USER_ID`. Supply
`USAGE_FROM`/`USAGE_TO` as exact UTC timestamps;
`TAG_KEY`/`TAG_VALUE` are optional. It performs reads only and does not claim that
a first detail page is complete history.

## Compatibility and verification

`TIDB_LINK_REVISION` / `tidbLinkRevision` identify the selected exact service
revision for every supported capability. `tidbLinkOpenApiSha256` pins that
service's `docs/openapi.yaml`. The former per-feature revision constants and
package fields have been removed; use these shared values instead.
`TIDB_LINK_API_VERSION` remains `0.0.1`; the version string alone does not establish
compatibility. This is a selective surface, not coverage of every service API.

`npm run test:service-contract` checks frozen selected SDK OpenAPI subsets from
that exact revision. The committed snapshot and metadata retain the source
fingerprint and immutable contract evidence; no live synchronization is required.
The snapshot alone does not certify service behavior.

`npm test` covers the simulated HTTP failure boundary and installs the actual
packed artifact in a clean ESM TypeScript consumer. To verify the packed SDK and
its examples against the real service, use the service's Node.js 26 runtime, install its
pinned dependencies, generate Prisma, build its Hardware contract and prepare its
current schema in a **dedicated test database**. See the selected service's
[current-schema setup](https://github.com/mem9-ai/agent-stack/blob/4305ef67daebf23c416badf806217a7c11dcef37/docs/prisma-first-tidb-validation-and-rollout.md).

```sh
AGENT_SERVICE_ROOT=/path/to/agent-stack \
TEST_TIDB_DATABASE_URL=mysql://root@127.0.0.1:4000/tidb_link_sdk_test \
TIDB_SSL=off npm run test:service
```

This command requires a clean service checkout at the exact revision. It builds
the service for the compiled Organization consumer and uses a dedicated TiDB
connection. Run just that consumer with:

```sh
AGENT_SERVICE_ROOT=/path/to/agent-stack \
TEST_TIDB_DATABASE_URL=mysql://root@127.0.0.1:4000/tidb_link_sdk_test \
TIDB_SSL=off npm run test:service -- organization/organization.compiled.fixture.ts
```

The compiled fixture reuses the service system harness, its isolated database,
controlled model/storage/ASR/voice dependencies and real background runner. A
separate process installs the tarball in a clean directory and calls only the
installed SDK and packaged Organization example for its application workflow.
It verifies Organization provisioning, discovery, Session
creation replay, owner isolation, file upload/download and message attachment,
text results and history, Client Tools on a Backend Connection, Connector registration and a Session's call
to the example HTTP Connector, audio,
Realtime HTTP grants, rotation/revocation and fresh-authority recovery. Management credential changes
and controlled suppliers are fixture actions, not claimed SDK APIs. WebSocket
redemption, live speech suppliers, physical hardware and deployment compatibility
are outside this SDK proof.

The remaining fixtures use the service's existing AppModule test seam and reset
all rows in the selected dedicated test database before and after their runs.
They use genuine credentials, real TiDB and controlled dependencies. Their scope:
Fixtures prepare identities, Templates and eligible
Realtime Sessions. A composed installed quickstart provisions one fresh User,
discovers Templates/models, creates a Session, obtains a final answer
and recovers the same original result. Public SDK methods also verify ownership,
lifecycle updates, Template switches with and without a Handoff Turn, and Realtime
operations. Text cases
exercise actual acceptance, final success/failure/interruption, local timeout and
abandoned-wait recovery, response-loss reconciliation, and paginated mixed
history through public SDK methods. Client Tool cases declare and replace tools
with ownership and stale-revision refusals. Backend Connection cases attach
Sessions, run the real Runtime's Client Tool calls through claim and result,
send messages, resume from a cursor, supersede connections and grant Realtime
tokens. A forwarding proxy drops only an actual service response to prove
uncertain-submission recovery. Control cases
verify active-Turn steering, eventual cancellation, disabled retry and an explicitly
enabled checkpoint retry with an unchanged original outcome. The enabled fixture
uses the existing controlled Drive9 and model suppliers. File cases use a separate
fixture lifecycle with real upload state and a controlled Drive9/S3 byte supplier.
They verify inline, multipart and empty uploads, cancellation and invalid content,
large-file download-ticket redemption, and a real Runtime file read whose answer
contains the uploaded content. The installed upload example exercises the same
public workflow. Real supplier deployment certification is outside this evidence.
Audio cases use the real transcription adapter with a controlled HTTP supplier.
They cover recorded input, malformed/unsupported recordings, supplier refusals,
model failure, active-response interruption and the installed audio example.
The public Session projection exposes the frozen Template digest but hides the
stored creation options. Those snapshots and active-Turn model freezing also rely
on the selected service's [existing persistence evidence](https://github.com/mem9-ai/agent-stack/blob/4305ef67daebf23c416badf806217a7c11dcef37/test/product/sessions/sessions-withorgstore.tidb.spec.ts); SDK reads alone do not
prove those hidden values.
Usage cases seed controlled facts and verify both public projections, exact filters,
paging and authority without executing messages to manufacture billing data.
No production supplier credentials or WebSocket redemption are needed. A
mismatch or unavailable service fails this check instead of silently skipping it.
