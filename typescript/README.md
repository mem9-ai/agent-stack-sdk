# `@mem9/tidb-link`

Official TypeScript SDK for Node.js 22.12 or newer. ESM only, with TypeScript
declarations and no runtime dependencies.

## Current refresh scope

This slice refreshes Organization information, End User provisioning and User API
Key management for [service revision b59a0a58](https://github.com/mem9-ai/agent-stack/commit/b59a0a584eb2632b8d9c6d0808b8ea26081b1474).
It replaces the removed Workspace/Service User provisioning surface. The existing
Agent, Session and Turn exports are retained for subsequent refresh
slices; they are **not verified or supported against this baseline**. Do not use
them as the next step in this provisioning example.

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
An Organization key likewise grants no User identity. Until the User client
refresh is delivered, verify the credential with the service's public User API,
for example `GET /api/v1/user/agents` using `Authorization: Bearer <token>`.

## Errors and uncertain outcomes

Every Organization method accepts a final `{ requestId?, signal? }` option.
`TiDBLinkApiError` preserves status, service code, request identity and details;
`ConflictError` preserves explicit 409/412 conflicts. The service's response
request identity takes precedence over the one sent.

Safe reads use bounded retries with the same request identity. User creation and
key creation/rotation/revocation are never automatically replayed. Disconnects, unusable
success responses, HTTP 408 and server failures during these mutations raise
`OutcomeUnknownError`. For an HTTP failure, its `cause` retains the
`TiDBLinkApiError`. Repeating revoke is safe, but an ambiguous failure
still reports an unknown outcome. `AbortSignal` stops the local request; after
dispatch it does not establish whether a mutation happened. Redirects are refused.

After uncertain User creation, list and match the original `externalId`.
After uncertain issuance or rotation, listing keys can confirm metadata but
**cannot recover the one-time token**. Reconcile metadata and explicitly revoke
any unwanted key before deciding whether to issue again. The example never
repeats an uncertain credential operation.

## Compatibility and verification

`TIDB_LINK_PROVISIONING_REVISION` and `tidbLinkProvisioningRevision` in the package identify the
exact service revision above. Package metadata `tidbLinkProvisioningOpenApiSha256` pins the SHA-256 of that
revision's `docs/openapi.yaml`. `TIDB_LINK_API_VERSION` remains `0.0.1`; the
version string alone does not establish compatibility. The verified scope is the
provisioning slice described here, not every retained export or every public API.

`TIDB_LINK_REVISION` / `tidbLinkRevision` retain revision
`49f2bb3b7d194ada614cf9caa0a79f24e7aeba87` for the unrefreshed User/Agent/Session/Turn
APIs. The existing immutable contract checks preserve evidence for that historical
surface; they do not certify it against the provisioning baseline. Run them with
`TIDB_LINK_CONTRACT=/path/to/contract npm run test:service-contract`, using the immutable artifact selected by this repository's CI workflow. It contains `openapi.json` and `metadata.json`.

`npm test` covers the simulated HTTP failure boundary and installs the actual
packed artifact in a clean ESM TypeScript consumer. To verify the packed SDK and
example against the real service, use the service's Node.js 26 runtime, install its
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
service's existing AppModule test fixture, genuine credentials and real TiDB;
fixtures prepare Organizations and controlled dependencies. No production
supplier credentials are needed. A mismatch or unavailable service fails this
check instead of silently skipping it.
