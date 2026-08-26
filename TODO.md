# TODO

## Publish `@mem9/agent-stack@0.1.0`

Status: blocked until an npm granular access token with publish access to `@mem9` and **bypass 2FA enabled** is available.

Completed:

- Added project discovery with `listProjects()` in commit `4f9a93c`.
- Fixed the release tag check in commit `ffc535a`.
- Pushed `main` and annotated tag `typescript-v0.1.0`.
- Passed typecheck, all 25 SDK tests, package installation/typecheck, and pack validation.
- Validated the new package against `https://ventured-agent-stack.pingcap.cn`: project discovery, Agent/Session creation, collected and streamed Turns, Drive9, sandbox, history, and `getTurn()` all passed.
- Release run `32940192816` passed every check before `npm publish`, which failed with `ENEEDAUTH` because the repository has no `NPM_TOKEN` secret.
- Retrieved the supplied npm token from Feishu without logging or persisting it and set the repository `NPM_TOKEN` secret through stdin.
- Re-ran release run `32940192816` (attempt 2). All checks passed again, but npm rejected publication with `E403`: the supplied token does not bypass the organization's publish-time 2FA requirement.

Resume steps:

1. Obtain an npm granular access token that can publish public packages in the `@mem9` scope and has **bypass 2FA enabled**. Do not paste it into this document or a shell argument.
2. Set it through stdin: `gh secret set NPM_TOKEN --repo mem9-ai/agent-stack-sdk`.
3. Re-run failed release run `32940192816` and require the publish job to pass.
4. Verify `npm view @mem9/agent-stack@0.1.0 version` returns `0.1.0`.
5. Replace the Demo's vendored tarball dependency with `@mem9/agent-stack@0.1.0`, install from the public registry in a clean directory, and repeat the deployment-environment end-to-end check.

References:

- Failed publish run: https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940192816
- Attempt 2 (`E403`, token lacks bypass 2FA): https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940192816/attempts/2
- Earlier workflow-quoting failure (fixed): https://github.com/mem9-ai/agent-stack-sdk/actions/runs/32940040198
