# Changelog

## Unreleased (0.3.0)

- Rename the package to `@mem9/tidb-link` and errors/constants to TiDB Link names.
- Require typed `ti_org_<id>_<secret>` / `ti_user_<id>_<secret>` credentials; old formats and exports have no compatibility aliases. HTTP resource paths stay unchanged.
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
