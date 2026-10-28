# `@mem9/tidb-link`

Official TypeScript SDK for Node.js 22.12 or newer. ESM only, with TypeScript
declarations and no runtime dependencies.

## Current refresh scope

This refresh supports Organization information, End User provisioning, User API
Key management, Template/model discovery, personal Agent and Session management,
text submission, steering, cancellation, checkpoint retry, original-result waiting,
continuous progress, conversation history, file attachments, Schedulers,
Realtime Model/Connection preparation and User usage reads for [service revision
0d11f1b2](https://github.com/mem9-ai/agent-stack/commit/0d11f1b231879c735bd53b60ff895ac58ba60d33).

Text commands return durable receipts independently of execution. Waiting reads the
original command's outcome. Template version application, Memory configuration,
default Agents and general Agent overrides are removed. Client Tools remain
a subsequent slice. Browser, MSP, management and device APIs are
outside this refresh.

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
access to the User's private Session content. The User retains access to its saved history.

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
through; this slice does not implement file upload. Successful `TurnResult`
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
import { sendMessageWorkflow } from "@mem9/tidb-link/examples/send-message.mjs";
const result = await sendMessageWorkflow({
  baseUrl: process.env.AGENT_SERVICE_URL,
  userApiKey: process.env.USER_API_KEY,
  sessionId: process.env.SESSION_ID,
  clientEventId: process.env.CLIENT_EVENT_ID,
  text: process.env.MESSAGE_TEXT,
});
```

Set those five environment variables to run the installed example directly:
`node node_modules/@mem9/tidb-link/examples/send-message.mjs`. It prints only the
final answer. Preserve the input across invocations; each new command identity
can start new work. This slice replaces the obsolete response-owned NDJSON
`streamTurn` API. Use the independent progress subscription below.

## Continuous progress and reconnection

Submit once with a persisted `clientEventId`, then observe that original receipt:

```ts
const accepted = await session.submitMessage({
  clientEventId: crypto.randomUUID(),
  text: "Summarize the findings",
});
let cursor: string | undefined;
let draft = "";
for await (const update of session.observe(accepted.inputId, {
  timeoutMs: 60_000,
})) {
  if (update.type === "result") {
    console.log(update.result.text);
  } else {
    cursor = update.event.cursor; // Persist with session.id and accepted.inputId.
    if (update.type === "draft") draft = update.text; // Replace, including an empty reset.
    if (update.type === "progress") console.log(update.text);
  }
}
```

`draft` is provisional, and a progress update or saved-message event is not a
successful result. Only `type: "result"` establishes the original command's
successful outcome using its durable receipt and matching saved Turn. Failures,
interruption and unincorporated inputs use the same errors as `waitForResult()`.
A later explicit retry cannot replace the earlier command's result.

`ObservationStoppedError` retains `sessionId`, `inputId`, `turnId` when known,
the last `cursor`, and `timedOut`. On disconnect, local abort or timeout, preserve
those values. Reconnect with `session.observe(inputId, { cursor })`, or query
`getInteraction(inputId)` / `waitForResult(inputId)`; do not submit another message.
Breaking the loop stops only observation. EOF, a revoked observer credential,
Session idleness and the absence of subscribers do not establish success or cancel
execution. With revoked credentials, use another currently authorized User Key
for recovery. The SDK does not automatically reconnect or resubmit.

`session.events({ cursor, signal })` exposes the independent Session-wide stream
as raw envelopes with `cursor`, `type`, `sessionId`, `turnId`, `createdAt` and
`data`, including Realtime and unfamiliar event types. It ends when its connection
ends; it has no execution-result promise. `observe()` selects the original Turn,
exposes typed draft/progress text and raw other events, and confirms its original
receipt before reporting a result. A missing/expired cursor is the service's
`validation_error` refusal; it does not silently start replay from the beginning.
A resumed draft is a complete snapshot, usable without earlier frames.

The packaged `observe-message.mjs` example observes an existing input and never
submits it again. Run it with `AGENT_SERVICE_URL`, `USER_API_KEY`, `SESSION_ID` and
`INPUT_ID`; supply `EVENT_CURSOR` to resume:

```sh
node node_modules/@mem9/tidb-link/examples/observe-message.mjs
```

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

The installed `@mem9/tidb-link/examples/control-turn.mjs` exports
`controlTurnWorkflow`. It returns cancellation acceptance for `action: "cancel"`
and waits for the separate retry result for `action: "retry"`. Run it with
`AGENT_SERVICE_URL`, `USER_API_KEY`, `SESSION_ID`, `TURN_ID`, `CLIENT_EVENT_ID` and
`TURN_ACTION` set; retain those identities before dispatch. This example never
chooses to retry automatically.

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
need. Transfers send only the grant's required headers, never the User API Key.
Uploads reject redirects; a download may follow one HTTPS redirect without an
API Key. Files are held in memory while hashing or downloading, so size your
backend's concurrency for the service's advertised maximum.

The packaged `upload-file.mjs` example uploads and attaches one file. Set
`AGENT_SERVICE_URL`, `USER_API_KEY`, `SESSION_ID`, `FILE_PATH`,
`UPLOAD_IDEMPOTENCY_KEY`, and `CLIENT_EVENT_ID`, then run:

```sh
node node_modules/@mem9/tidb-link/examples/upload-file.mjs
```

The example returns the final conversation result; its exported
`uploadFileWorkflow()` accepts bytes directly. It does not manage general Drive
directories, write Session text files, or grant Organization access to User files.

## Scheduled work

`user.schedulers` uses the full customer Scheduler API. A new-Session schedule
requires an owned Agent; a bound-Session schedule supplies only its Session.
The service resolves the Agent from that Session.

```ts
const created = await customer.schedulers.create({
  agentId: agent.id,
  title: "Morning report",
  prompt: "Summarize the latest activity.",
  schedule: { kind: "cron", cronExpr: "0 9 * * *", timezone: "Asia/Shanghai" },
  idempotencyKey: savedSchedulerKey,
});
const current = await customer.schedulers.get(created.scheduler.schedulerId);
const updated = await customer.schedulers.update(
  current.scheduler.schedulerId,
  { enabled: false },
  { ifMatch: current.etag },
);
const history = await customer.schedulers.fires(current.scheduler.schedulerId, {
  limit: 20,
});
```

For one-time work use exactly one of `{ kind: "once", runAt: isoTimestamp }` or
`{ kind: "once", after: "1h30m" }`. `runAt` includes a timezone offset; cron
requires an IANA timezone. The service owns timing and validation. Optional
`validFrom` and `validUntil` restrict the execution window. A bound-Session create
uses `delivery: { target: "bound_session", sessionId }` and omits `agentId`.

Creation returns `{ scheduler, etag }`. Persist the key and exact input before
calling. A same-key replay returns the **original creation response and ETag**,
even if the Scheduler has since changed; use `get()` for current state before an
edit. A changed input with that key is refused. Uncertain responses raise
`OutcomeUnknownError` rather than repeating the command automatically.
`idempotency_in_progress` retains the service's raw `retryAfter` header on the
error so the application can decide when to replay the original request.

`update(id, changes, { ifMatch })` and `delete(id, { ifMatch })` require a
previously read ETag. Stale writes retain the service's 412 conflict; the SDK
never refreshes and overwrites another writer's changes. Updates support title,
prompt, Agent/delivery target, schedule, enabled state, validity window and
`snoozeUntil`. Enabling an elapsed one-time schedule requires a future time.
Disabling or deleting a Scheduler does not roll back completed effects. Deleted
Schedulers are no longer available through detail or fire-history reads.

`list({ status, limit, cursor })` and `fires(id, { limit, cursor })` return
`nextCursor` rather than `hasMore`. Cursors retain their original owner/filter
scope. Each fire preserves its execution prompt and delivery snapshot; later
Scheduler edits cannot rewrite it. `pending` is not success. A `completed` fire
or a `failed` fire retains nullable result identities and a nullable failure code.
When `result.sessionId` and `result.turnId` are present, read the saved Turn with
`customer.session(sessionId).getTurn(turnId)`; do not invent a message identity
when `messageId` is null.

The installed `schedule-task.mjs` example creates one scheduled task, waits
locally for a settled fire and reads its associated Turn. Set `AGENT_SERVICE_URL`,
`USER_API_KEY`, `AGENT_ID`, `SCHEDULER_IDEMPOTENCY_KEY`, `SCHEDULE_RUN_AT` and
`SCHEDULE_PROMPT`, then run:

```sh
node node_modules/@mem9/tidb-link/examples/schedule-task.mjs
```

A local example timeout leaves the schedule active and prints its identity for
later fire-history reads. The separate Scheduler plans API is outside this SDK.

## Errors and uncertain outcomes

Organization, text/progress/history and refreshed Agent/Session lifecycle methods accept
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

## User usage

A User client reads its own usage. An Organization client must name a target User
in that Organization. These are distinct response projections and date contracts:

| Read | User client | Organization client |
| --- | --- | --- |
| Summary | `getUsage(options)` | `getUserUsage(userId, options)` |
| Details | `getUsageDetails(options)` | `getUserUsageDetails(userId, options)` |
| Range | Optional inclusive UTC dates, `YYYY-MM-DD`; at most 370 days | Required exact UTC timestamps with milliseconds, inclusive `from` and exclusive `to`; at most 31 days |
| Buckets | `period: "day"` or `"week"` chooses the default range; series remains daily | `interval: "hour"`, `"day"`, `"week"` or `"month"` |
| Detail limits | Separate `llm`, `sandbox` and `webSearch` arrays; `limit` applies per kind, with no cursor | Globally ordered `items`; optional `kind`, `limit` and opaque `cursor`; `nextCursor: null` ends the stream |

Both support an exact `tagKey`/`tagValue` pair. Send both or neither. Values retain
case sensitivity and the service's normalization rules. Preserve the original
range, kind and tag filters when following an Organization cursor. Details accept
limits from 1 to 500. The User detail endpoint cannot retrieve older rows beyond
its limit through a fabricated continuation; Organization details support paging.

```ts
const own = await user.getUsage({
  from: "2030-01-02", to: "2030-01-02", period: "day",
});
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
infer a balance from these reads. Organization projections intentionally omit
some details available in the User's own projection.

The installed example `@mem9/tidb-link/examples/read-usage.mjs` exports
`readOwnUsage` and `readUserUsage`, each returning a summary and the first detail
page. The CLI requires `AGENT_SERVICE_URL` and `USAGE_AUTHORITY=user` with
`USER_API_KEY`, or `USAGE_AUTHORITY=organization` with `ORGANIZATION_API_KEY` and
`END_USER_ID`. Supply `USAGE_FROM`/`USAGE_TO` in the corresponding date format;
`TAG_KEY`/`TAG_VALUE` are optional. It performs reads only and does not claim that
a first detail page is complete history.

## Compatibility and verification

`TIDB_LINK_REVISION` / `tidbLinkRevision` identify the selected exact service
revision. The provisioning, lifecycle, Realtime and text constants and package
fields identify their individually verified slices. `TIDB_LINK_TEXT_REVISION` /
`tidbLinkTextRevision` covers text and control commands, progress, original results and history;
`tidbLinkTextOpenApiSha256` pins the selected service's `docs/openapi.yaml`.
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
[current-schema setup](https://github.com/mem9-ai/agent-stack/blob/0d11f1b231879c735bd53b60ff895ac58ba60d33/docs/prisma-first-tidb-validation-and-rollout.md).

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
creation, ownership checks, lifecycle updates and Realtime operations. Text cases
exercise actual acceptance, final success/failure/interruption, local timeout and
abandoned-wait recovery, response-loss reconciliation, and paginated mixed
history through public SDK methods. Progress cases verify draft replacement, cursor
reconnection/refusal, original-result confirmation, local observation timeout and
live credential revocation without remote cancellation. A forwarding proxy drops only
an actual service response to prove uncertain-submission recovery. Control cases
verify active-Turn steering, eventual cancellation, disabled retry and an explicitly
enabled checkpoint retry with an unchanged original outcome. The enabled fixture
uses the existing controlled Drive9 and model suppliers. File cases use a separate
fixture lifecycle with real upload state and a controlled Drive9/S3 byte supplier.
They verify inline, multipart and empty uploads, cancellation and invalid content,
large-file download-ticket redemption, and a real Runtime file read whose answer
contains the uploaded content. The installed upload example exercises the same
public workflow. Real supplier deployment certification is outside this evidence.
Scheduler cases enable the real background runner and use SDK-created schedules
to verify successful and failed execution, delivery changes, retained fire
snapshots and the installed example.
The public Session projection exposes the frozen Template digest but hides stored
Agent preferences. Preference snapshots and active-Turn model freezing also rely
on the selected service's [existing persistence evidence](https://github.com/mem9-ai/agent-stack/blob/0d11f1b231879c735bd53b60ff895ac58ba60d33/test/product/sessions/sessions-withorgstore.tidb.spec.ts); SDK reads alone do not
prove those hidden values.
Usage cases seed controlled facts and verify both public projections, exact filters,
paging and authority without executing messages to manufacture billing data.
No production supplier credentials or WebSocket redemption are needed. A
mismatch or unavailable service fails this check instead of silently skipping it.
