# TODO

## Publish `@mem9/agent-stack@0.1.0`

Status: completed on 2026-08-26.

Completed:

- Added project discovery with `listProjects()` in commit `4f9a93c`.
- Fixed the release tag check in commit `ffc535a`.
- Pushed `main` and annotated tag `typescript-v0.1.0`.
- Passed typecheck, all 25 SDK tests, package installation/typecheck, and pack validation.
- Validated the new package against `https://ventured-agent-stack.pingcap.cn`: project discovery, Agent/Session creation, collected and streamed Turns, Drive9, sandbox, history, and `getTurn()` all passed.
- Release run `32940192816` passed every check before `npm publish`, which failed with `ENEEDAUTH` because the repository has no `NPM_TOKEN` secret.
- Retrieved the supplied npm token from Feishu without logging or persisting it and set the repository `NPM_TOKEN` secret through stdin.
- Re-ran release run `32940192816` (attempt 2). All checks passed again, but npm rejected publication with `E403`: the supplied token does not bypass the organization's publish-time 2FA requirement.
- Replaced the secret with the newer bypass-2FA token from Feishu; npm then accepted the token.
- Disabled provenance in commits `07529b8` and `7cde990` because npm cannot verify provenance from a private GitHub source repository.
- Published `@mem9/agent-stack@0.1.0` successfully in release run `32945979418` after all 25 tests, typecheck, pack, and tag checks passed.
- Verified the public registry returns version `0.1.0` and tarball shasum `a95a416bd1688e58906d36888bd1ce7023bf3002`.
- Replaced the Demo's vendored dependency with exact registry version `0.1.0`, passed a clean-directory import check, and repeated the deployment-environment end-to-end check successfully.

References:

- Failed publish run: https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940192816
- Attempt 2 (`E403`, token lacks bypass 2FA): https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940192816/attempts/2
- Private-repository provenance failures: https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32945822997
- Successful publish: https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32945979418
- Earlier workflow-quoting failure (fixed): https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940040198
