# Changelog

## Unreleased (0.3.0)

- Add explicit exact-Turn cancellation and checkpoint retry with recoverable
  command identities; wait for retry results without replacing earlier outcomes.
- Verify active-Turn steering through message admission, eventual cancellation,
  enabled and disabled checkpoint retry using the installed SDK and real service.


- Refresh Organization information, End User creation/listing/retrieval and User
  API Key creation/listing/rotation/revocation for service revision `b59a0a58`.
- Replace the obsolete ServiceUser handle with explicit Organization operations;
  preserve uncertain creation/issuance and one-time credential delivery.
- Verify the packed SDK and provisioning, Session creation and Realtime examples against
  the actual service and TiDB.
- Discover Realtime Models, conditionally select the next connection's model,
  and prepare/read/end Session Realtime Connections with one-time connect tokens.

- Rename the package to `@mem9/tidb-link` and errors/constants to TiDB Link names.
- Require typed `ti_org_<id>_<secret>` / `ti_user_<id>_<secret>` credentials; old formats and exports have no compatibility aliases.
- Reject unusable one-time User Key responses without automatically repeating issuance.

- Discover available Templates with cursor pagination and deployment models by
  their current IDs; create independent Agents for the same Template with stable
  creation keys and update owner-only additional instructions.
- Create, list, retrieve, rename and delete owned Sessions; select models with
  stale-update protection and replace or clear Billing Tags.
- Explicitly unlink a target User's Agent with Organization authority while
  retaining Session ownership and configuration.
- Remove retired Template version/application, Memory, default-Agent and general
  Agent configuration exports.

- Submit text commands with caller-retained identities, distinguish acceptance,
  incorporation and final results, and reconcile uncertain submissions without
  automatic execution replay.
- Wait for original-generation outcomes with recoverable local timeout/abort;
  read paginated interactions, Full Agent/Realtime Turns and Session Timeline.
- Replace obsolete NDJSON Turn streaming with the current receipt-based text
  interface. Continuous progress remains a subsequent slice.
- Verify the text/history slice against exact service revision `b59a0a58`, with
  actual-service outcomes and response loss, a packaged runnable example and an
  independent packed TypeScript consumer; refresh the frozen contract evidence.

## 0.2.0

- Replace Workspace and Project authority with Organization and User authority.
- Match the Pi-only Agent, Agent-bound Session, Session Model, Clarification,
  result, and Memory contract in Agent Service revision
  `9c1e9aceb28afce1166e4249ea104c7a2f8aac73`.
- Remove SDK fields for Runtime selection, Codex, Agent Instructions, structured
  Turn output, and other unsupported capabilities.
- Verify pull requests, releases, and packed artifacts against the immutable
  compatible Agent Service OpenAPI contract.
