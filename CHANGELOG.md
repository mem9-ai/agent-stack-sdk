# Changelog

## Unreleased (0.3.0)

- Use customer `/api/v1` routes with Organization-Key Business User admission and
  the retained one-time User Key lifecycle.
- Expose published Template summaries and unique User × Template Agent
  associations. Ordinary behavior and answer models belong to the publication.
- Support fixed-configuration Session creation with explicit recoverable identities
  and owner metadata lifecycle.
- Add stable message/cancellation input IDs, distinct accepted/replayed SDK receipts,
  paginated saved interactions, original-input recovery and ordered user Messages.
- Drain normal execution through EOF, close abandoned owning requests, and preserve
  that connection while auxiliary steering/stop acknowledgments return.
- Remove ordinary configuration, Template-version/application and Session-model
  mutation contracts from the customer SDK.
- Preserve private Memory credential operations and strict typed API Key grammar.

## 0.2.0

- Replace Workspace and Project authority with Organization and User authority.
- Match the Pi-only Agent, Agent-bound Session, Session Model, Clarification,
  result, and Memory contract in Agent Service revision
  `9c1e9aceb28afce1166e4249ea104c7a2f8aac73`.
- Remove SDK fields for Runtime selection, Codex, Agent Instructions, structured
  Turn output, and other unsupported capabilities.
- Verify pull requests, releases, and packed artifacts against the immutable
  compatible Agent Service OpenAPI contract.
