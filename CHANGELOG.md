# Changelog

## Unreleased (0.3.0)

- Add `OrganizationClient.user(userId)` for the existing supported End User
  resource workflows without issuing a User Key. Retain `UserClient` compatibility,
  real authorizing credentials, owner-scoped handles and separate usage projections.
- Pin the supported contract to service
  `24be606699db1386d7a17b10ef24c3414b494bf9` and OpenAPI SHA-256
  `906515e4c8d38c5ac9fce6390d9d646220b2d06100fbcb64e180419899989a5b`.
- Include `organization_user` billing attribution and deleted Scheduler history.
  Add a packaged Organization example and a compiled-backend independent packed
  consumer for the supported journey. MCP, general Drive management and WebSocket
  media transport remain outside the SDK. No package publication is performed.

- Bind User API Key creation, rotation and revocation receipts to their requested
  targets. Validate credential status and token/key identity, preserving unknown
  outcomes and request IDs without automatically replaying credential mutations.

- Consolidate service compatibility metadata under `TIDB_LINK_REVISION`,
  `tidbLinkRevision` and `tidbLinkOpenApiSha256`. Remove the Provisioning,
  Realtime, Lifecycle and Text revision exports and duplicate package fields;
  the selected service revision and contract fingerprints are unchanged.

- Refresh the Node.js ESM SDK for exact Agent Service revision
  `0d11f1b231879c735bd53b60ff895ac58ba60d33`, retaining Node.js 22.12 or newer
  and no runtime dependencies. The package remains unpublished by this change.
- Separate Organization and User authority. Support Organization information,
  End User provisioning and User API Key creation, reads, rotation and revocation,
  preserving uncertain outcomes and one-time credential delivery.
- Discover Templates/models; manage independent Agents and owned Sessions with
  stable creation identities, model revision checks, names and Billing Tags.
  Organization callers can explicitly unlink a target User's Agent.
- Submit text and steer active work; wait for or observe original results with
  resumable event positions and replacement drafts. Support explicit cancellation,
  checkpoint retry and paginated interaction/Turn/Timeline history without
  treating acceptance, EOF or an abandoned wait as success or cancellation.
- Declare/replace Client Tools, recover pending calls and explicitly submit the
  application's successful or failed outputs; no automatic tool execution.
- Upload inline, multipart and empty files with complete integrity checks,
  cancellation and original-key recovery; attach ready files and inspect or
  download their content without forwarding API Keys to grant-only destinations.
- Manage Schedulers with creation identity, conditional updates, pagination and
  fire history. Read User and Organization target-User usage without changing
  unknown, unpriced, incomplete or estimated facts.
- Submit prerecorded audio with its own interruption semantics, and prepare/read/
  end Realtime Connections with one-time credentials. Audio transport, capture,
  playback, browser, MSP and management integrations remain excluded.
- Reject hidden JavaScript transport/retry options and retain original identities
  across caller mutation. Verify shipped examples and the composed application
  quickstart using the installed packed SDK against the exact real service;
  independent TypeScript consumers and frozen contracts supplement that evidence.
- Remove obsolete Workspace/ServiceUser, Template-version/Memory/default-Agent
  and compatibility exports. Use the current `@mem9/tidb-link` package and typed
  `ti_org_<id>_<secret>` / `ti_user_<id>_<secret>` credential grammar.

## 0.2.0

- Replace Workspace and Project authority with Organization and User authority.
- Match the Pi-only Agent, Agent-bound Session, Session Model, Clarification,
  result, and Memory contract in Agent Service revision
  `9c1e9aceb28afce1166e4249ea104c7a2f8aac73`.
- Remove SDK fields for Runtime selection, Codex, Agent Instructions, structured
  Turn output, and other unsupported capabilities.
- Verify pull requests, releases, and packed artifacts against the immutable
  compatible Agent Service OpenAPI contract.
