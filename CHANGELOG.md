# Changelog

## Unreleased (0.3.0)

- Refresh Organization information, End User creation/listing/retrieval and User
  API Key creation/listing/rotation/revocation for service revision `b59a0a58`.
- Replace the obsolete ServiceUser handle with explicit Organization operations;
  preserve uncertain creation/issuance and one-time credential delivery.
- Verify the packed SDK and provisioning CLI against the actual service and TiDB.
  Retain the earlier contract evidence for APIs awaiting their refresh.

- Rename the package to `@mem9/tidb-link` and errors/constants to TiDB Link names.
- Require typed `ti_org_<id>_<secret>` / `ti_user_<id>_<secret>` credentials; old formats and exports have no compatibility aliases.
- Reject unusable one-time User Key responses without automatically repeating issuance.

- Require explicit published Template selection for new Agents.
- Add descriptive Hardware configuration, content version 2 types, published version reads and explicit Template application with preserved override/reset intent.
- Keep Console Draft Preview separate from the User-key SDK.

## 0.2.0

- Replace Workspace and Project authority with Organization and User authority.
- Match the Pi-only Agent, Agent-bound Session, Session Model, Clarification,
  result, and Memory contract in Agent Service revision
  `9c1e9aceb28afce1166e4249ea104c7a2f8aac73`.
- Remove SDK fields for Runtime selection, Codex, Agent Instructions, structured
  Turn output, and other unsupported capabilities.
- Verify pull requests, releases, and packed artifacts against the immutable
  compatible Agent Service OpenAPI contract.
