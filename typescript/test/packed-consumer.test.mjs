import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("the packed SDK installs and typechecks in a clean ESM consumer", async (context) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), "tidb-link-sdk-consumer-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const pack = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  )[0];
  const files = pack.files.map(({ path: file }) => file).sort();
  assert(files.includes("LICENSE"));
  assert(files.includes("README.md"));
  assert(files.includes("package.json"));
  assert(files.includes("dist/index.js"));
  assert(files.includes("dist/index.d.ts"));
  assert(files.includes("examples/provision-user.mjs"));
  assert(files.includes("examples/prepare-realtime-connection.mjs"));
  assert(files.includes("examples/create-session.mjs"));
  assert(files.includes("examples/send-message.mjs"));
  assert(!files.some((file) => file.includes("workspace")));
  assert(
    files.every(
      (file) =>
        file === "LICENSE" ||
        file === "README.md" ||
        file === "package.json" ||
        file === "examples/provision-user.mjs" ||
        file === "examples/prepare-realtime-connection.mjs" ||
        file === "examples/create-session.mjs" ||
        file === "examples/send-message.mjs" ||
        /^dist\/.+\.(?:js|d\.ts|map)$/.test(file),
    ),
  );

  const tarball = path.join(temporary, pack.filename);
  await writeFile(
    path.join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    {
      cwd: temporary,
      stdio: "pipe",
    },
  );

  await writeFile(
    path.join(temporary, "consumer.ts"),
    `import type {
      Agent,
      AgentRecord,
      AgentTemplatePage,
      AgentModelCatalog,
      SessionPage,
      CreateSessionOptions,
      Organization,
      EndUser,
      IssuedUserApiKey,
      UserApiKey,
      Session,
      RealtimeAudioFormats,
      RealtimeConnectGrant,
      RealtimeConnection,
      RealtimeModelCatalog,
      RealtimeModelSelection,
      OpenRealtimeConnectionResult,
      TurnResult,
      CreateTurnInput,
      SessionInteraction,
      SessionInteractionPage,
      SessionTimelinePage,
      TurnPage,
      WaitForResultOptions,
    } from "@mem9/tidb-link";
    import {
      TIDB_LINK_API_VERSION,
      TIDB_LINK_REVISION,
      TIDB_LINK_PROVISIONING_REVISION,
      TIDB_LINK_REALTIME_REVISION,
      TIDB_LINK_LIFECYCLE_REVISION,
      TIDB_LINK_TEXT_REVISION,
      OutcomeUnknownError,
      TurnWaitTimeoutError,
      TurnFailedError,
      TurnInterruptedError,
      InputNotAppliedError,
      TiDBLinkApiError,
      TiDBLinkError,
      OrganizationClient,
      UserClient,
    } from "@mem9/tidb-link";
    // @ts-expect-error Previous compatibility constants and error exports have no aliases.
    import { AGENT_SERVICE_API_VERSION, AGENT_SERVICE_REVISION, AgentStackError, AgentStackApiError } from "@mem9/tidb-link";
    // @ts-expect-error Workspace authority was removed from the supported SDK.
    import { WorkspaceClient } from "@mem9/tidb-link";

    declare const baseUrl: string;
    declare const organizationApiKey: string;
    const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
    declare const userApiKey: string;
    async function provisionEndUser(): Promise<EndUser> {
      const current: Organization = await organization.getOrganization();
      const created: EndUser = await organization.createEndUser({
        externalId: "customer_1", displayName: "Customer",
      });
      const users: EndUser[] = await organization.listEndUsers();
      const found: EndUser = await organization.getEndUser(created.userId);
      const issued: IssuedUserApiKey = await organization.createUserApiKey(created.userId, { name: "backend" });
      const keys: UserApiKey[] = await organization.listUserApiKeys(created.userId);
      const rotated: IssuedUserApiKey = await organization.rotateUserApiKey(issued.apiKey.apiKeyId);
      const revoked: UserApiKey = await organization.revokeUserApiKey(rotated.apiKey.apiKeyId);
      void current; void users; void keys; void revoked;
      return found;
    }
    async function lifecycleWorkflow(): Promise<Session> {
      const user = new UserClient({ baseUrl, apiKey: userApiKey });
      const templates: AgentTemplatePage = await user.listAgentTemplates({limit:1});
      const models: AgentModelCatalog = await user.listModels();
      const agent: Agent = await user.createAgent({agentTemplateId:templates.templates[0]!.agentTemplateId,idempotencyKey:"agent-1"});
      await agent.update({additionalInstructions:"Concise"});
      const options: CreateSessionOptions = {idempotencyKey:"session-1",model:models.effectiveDefaultModel};
      const session: Session = await agent.createSession(options);
      await session.rename("My Session");
      await session.suggestName({userText:"Hello"});
      await session.setBillingTag({key:"account",value:"customer"});
      await session.setModel("dynamic.model");
      const page: SessionPage = await user.listSessions({limit:1});
      const archived: AgentRecord = await organization.unlinkAgent(agent.data.ownerUserId,agent.id);
      // @ts-expect-error Retired Template versions are not creation selectors.
      user.createAgent({agentTemplateId:"template_1",idempotencyKey:"a",templateVersion:1});
      // @ts-expect-error Agent creation requires a recoverable identity.
      user.createAgent({agentTemplateId:"template_1"});
      // @ts-expect-error Session creation requires a recoverable identity.
      agent.createSession();
      // @ts-expect-error Memory and general config overrides are retired.
      agent.configure({memory:{enabled:true}});
      void page; void archived;
      return session.delete();
    }
    async function realtimeWorkflow(session: Session): Promise<RealtimeConnection> {
      const user = new UserClient({ baseUrl, apiKey: userApiKey });
      const catalog: RealtimeModelCatalog = await user.listRealtimeModels();
      const current: RealtimeModelSelection = await session.getRealtimeModelSelection();
      const selected: RealtimeModelSelection = await session.setRealtimeModel(catalog.models[0]!.id, { ifMatch: current.etag });
      const audio: RealtimeAudioFormats = {
        input: { encoding: "pcm16", sampleRate: 16000, channels: 1 },
        output: { encoding: "opus", sampleRate: 24000, channels: 1, packetDurationMs: 20, bitrate: 24000 },
      };
      const prepared: OpenRealtimeConnectionResult = await session.openRealtimeConnection({ audio });
      const grant: RealtimeConnectGrant = await session.createRealtimeConnectToken();
      void selected; void prepared; void grant;
      const inspected: RealtimeConnection = await session.getRealtimeConnection();
      return session.endRealtimeConnection().then(() => inspected);
    }
    // @ts-expect-error Retired Service User handles are not an Organization capability.
    organization.serviceUser("user_1");
    // @ts-expect-error Native End User creation replaces the retired Service User operation.
    organization.createServiceUser({ displayName: "Customer" });
    // @ts-expect-error Project selection was removed from User authority.
    new UserClient({ baseUrl, apiKey: "ti_user_key_${"x".repeat(43)}", projectId: "removed" });
    // @ts-expect-error Runtime selection is not an Agent configuration capability.
    const removedRuntime: CreateSessionOptions = { idempotencyKey:"a", runtime: { backend: "codex", authId: "removed" } };
    declare const session: Session;
    session.setModel("deployment.model");
    // @ts-expect-error Structured Turn output is not supported.
    session.turn({ clientEventId:"input_1", text: "Hello", outputSchema: { type: "object" } });
    async function textWorkflow(session: Session): Promise<TurnResult> {
      const input: CreateTurnInput = {clientEventId:"input_1",text:"Hello"};
      const accepted: SessionInteraction = await session.submitMessage(input);
      const recovered: SessionInteraction | null = await session.reconcileInteraction(input.clientEventId);
      const interactions: SessionInteractionPage = await session.listInteractions({limit:1});
      const turns: TurnPage = await session.history({cursor:"opaque"});
      const timeline: SessionTimelinePage = await session.timeline({limit:1});
      for(const turn of turns.turns) {
        if(turn.executor === "realtime_model") { const id: string = turn.realtime.connectionId; void id; }
      }
      const options: WaitForResultOptions = {timeoutMs:1000,pollIntervalMs:50};
      void accepted; void recovered; void interactions; void timeline;
      // @ts-expect-error A caller-persisted input identity is required.
      session.turn({text:"Hello"});
      // @ts-expect-error The obsolete response-owned Turn stream is removed.
      session.streamTurn(input);
      return session.waitForResult(input.clientEventId,options);
    }
    function recover(error: unknown) {
      if(error instanceof OutcomeUnknownError || error instanceof TurnWaitTimeoutError || error instanceof TurnFailedError || error instanceof TurnInterruptedError || error instanceof InputNotAppliedError) {
        const inputId: string | undefined = error.inputId;
        const sessionId: string | undefined = error.sessionId;
        void inputId; void sessionId;
      }
    }
    void textWorkflow; void recover; void TIDB_LINK_TEXT_REVISION;
    void TIDB_LINK_API_VERSION;
    void TIDB_LINK_REVISION;
    void TIDB_LINK_PROVISIONING_REVISION;
    void TIDB_LINK_REALTIME_REVISION;
    const apiError: TiDBLinkError = new TiDBLinkApiError({ status: 400, code: "test", message: "safe" });
    void apiError;
    void WorkspaceClient;
    void removedRuntime;
    void provisionEndUser;
    void lifecycleWorkflow;
    void realtimeWorkflow;
    `,
  );
  const tsc = path.join(
    repositoryRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  execFileSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      "--lib",
      "ES2023,DOM,DOM.Iterable",
      "consumer.ts",
    ],
    { cwd: temporary, encoding: "utf8", stdio: "pipe" },
  );

  const installedRoot = path.join(
    temporary,
    "node_modules",
    "@mem9",
    "tidb-link",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.tidbLinkApiVersion, "0.0.1");
  assert.equal(
    installedPackage.tidbLinkRevision,
    "0d11f1b231879c735bd53b60ff895ac58ba60d33",
  );
  assert.equal(
    installedPackage.tidbLinkProvisioningRevision,
    "0d11f1b231879c735bd53b60ff895ac58ba60d33",
  );
  assert.equal(
    installedPackage.tidbLinkProvisioningOpenApiSha256,
    "ce6ac6c2b1e2e50461455a85eb4aedffd8958019d15ef95e6b8254eaef54a9dc",
  );
  assert.equal(
    installedPackage.tidbLinkRealtimeRevision,
    "0d11f1b231879c735bd53b60ff895ac58ba60d33",
  );
  assert.equal(
    installedPackage.tidbLinkRealtimeOpenApiSha256,
    "ce6ac6c2b1e2e50461455a85eb4aedffd8958019d15ef95e6b8254eaef54a9dc",
  );
  assert.equal(installedPackage.name, "@mem9/tidb-link");
  assert.match(installedPackage.version, /^0\./);
  assert.equal(installedPackage.type, "module");
  assert.equal(installedPackage.engines.node, ">=22.12");
  assert.deepEqual((await readdir(installedRoot)).sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "examples",
    "package.json",
  ]);

  const publishedFiles = await readdir(installedRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const credentialPattern =
    /ti_(?:org|user)_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{43}|rct_[A-Za-z0-9_-]{16,}|ag9_oak\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{32,}|ag9_uak_[A-Za-z0-9]{1,64}_[A-Za-z0-9_-]{32,}/;
  for (const file of publishedFiles) {
    if (!file.isFile()) continue;
    const contents = await readFile(
      path.join(file.parentPath, file.name),
      "utf8",
    );
    assert.doesNotMatch(contents, credentialPattern);
  }

  await writeFile(
    path.join(temporary, "consumer.mjs"),
    `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import * as sdk from "@mem9/tidb-link";
    assert.equal(sdk.TIDB_LINK_API_VERSION, "0.0.1");
    assert.equal(sdk.TIDB_LINK_REVISION, ${JSON.stringify(installedPackage.tidbLinkRevision)});
    assert.equal(sdk.TIDB_LINK_PROVISIONING_REVISION, ${JSON.stringify(installedPackage.tidbLinkProvisioningRevision)});
    assert.equal(sdk.TIDB_LINK_LIFECYCLE_REVISION, ${JSON.stringify(installedPackage.tidbLinkLifecycleRevision)});
    assert.equal(sdk.TIDB_LINK_REALTIME_REVISION, ${JSON.stringify(installedPackage.tidbLinkRealtimeRevision)});
    const { provisionUser } = await import("@mem9/tidb-link/examples/provision-user.mjs");
    const { prepareRealtimeConnection } = await import("@mem9/tidb-link/examples/prepare-realtime-connection.mjs");
    const { sendMessageWorkflow } = await import("@mem9/tidb-link/examples/send-message.mjs");
    assert.equal(typeof sendMessageWorkflow,"function");
    assert.equal(sdk.TIDB_LINK_TEXT_REVISION, "0d11f1b231879c735bd53b60ff895ac58ba60d33");
    const { createSessionWorkflow } = await import("@mem9/tidb-link/examples/create-session.mjs");
    assert.equal(typeof createSessionWorkflow, "function");
    assert.equal(typeof provisionUser, "function");
    assert.equal(typeof prepareRealtimeConnection, "function");
    assert.equal(sdk.ServiceUser, undefined);
    for (const name of ["AGENT_SERVICE_API_VERSION", "AGENT_SERVICE_REVISION", "AgentStackError", "AgentStackApiError"]) {
      assert.equal(sdk[name], undefined);
    }
    const orgKey = "ti_org_key_" + "x".repeat(43);
    const userKey = "ti_user_key_" + "y".repeat(43);
    const rotatedKey = "ti_user_key_" + "z".repeat(43);
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, key: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/user/agents") {
        response.end(JSON.stringify({ agents: [] }));
      } else if (request.url === "/api/v1/realtime-models") {
        response.end(JSON.stringify({
          defaultModel: "voice-a",
          models: [{ id: "voice-a", label: "Voice A", available: true, isDefault: true, languages: ["en-US"], endpointingModes: ["client"], audio: { input: [], output: [] } }],
        }));
      } else if (request.url === "/api/v1/user/sessions/session_1") {
        response.end(JSON.stringify({ session: {
          realtimeModel: "voice-a", realtimeModelRevision: 1,
          realtimeModelEtag: "realtime-v1", realtimeVoice: { language: "en-US" },
        } }));
      } else if (request.url === "/api/v1/user/sessions/session_1/realtime") {
        response.writeHead(201).end(JSON.stringify({
          realtimeConnection: {
            object: "realtime_connection", id: "rtc_1", sessionId: "session_1", agentId: "agent_1",
            provider: { name: "mock", region: "test", model: "voice-a" }, status: "connecting",
            audio: { input: { encoding: "pcm16", sampleRate: 16000, channels: 1 }, output: { encoding: "pcm16", sampleRate: 24000, channels: 1 } },
            activeTaskTurnId: null, usage: { inputAudioSec: 0, outputAudioSec: 0, thoughtTokens: 0, textTokens: 0 },
            metadata: {}, createdAt: "2026-10-27T00:00:00.000Z", endedAt: null,
          },
          websocketUrl: "wss://voice.example/ws",
          connectToken: "rct_" + "p".repeat(43),
          connectTokenExpiresAt: "2026-10-27T00:01:00.000Z",
        }));
      } else {
        const token = request.url.endsWith("/rotate") ? rotatedKey : userKey;
        response.writeHead(201).end(JSON.stringify({ apiKey: { apiKeyId: "uak_key" }, token }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const org = new sdk.OrganizationClient({ baseUrl, apiKey: orgKey });
      const { token } = await org.createUserApiKey("user_1", { name: "test" });
      assert.equal(token, userKey);
      const user = new sdk.UserClient({ baseUrl, apiKey: token });
      assert.deepEqual(await user.listAgents(), []);
      const rotated = await org.rotateUserApiKey("uak_key");
      assert.equal(rotated.token, rotatedKey);
      assert.deepEqual(await new sdk.UserClient({ baseUrl, apiKey: rotated.token }).listAgents(), []);
      const prepared = await prepareRealtimeConnection({
        baseUrl,
        userApiKey: rotated.token,
        sessionId: "session_1",
      });
      assert.equal(prepared.realtimeConnection.id, "rtc_1");
      assert.match(prepared.connectToken, /^rct_/);
      assert.equal(JSON.stringify(new sdk.UserClient({ baseUrl, apiKey: rotated.token })).includes(prepared.connectToken), false);
      assert.deepEqual(requests, [
        {method:"POST",url:"/api/v1/org/users/user_1/api-keys",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/v1/user/agents",key:"Bearer " + userKey},
        {method:"POST",url:"/api/v1/org/user-api-keys/uak_key/rotate",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/v1/user/agents",key:"Bearer " + rotatedKey},
        {method:"GET",url:"/api/v1/realtime-models",key:"Bearer " + rotatedKey},
        {method:"GET",url:"/api/v1/user/sessions/session_1",key:"Bearer " + rotatedKey},
        {method:"POST",url:"/api/v1/user/sessions/session_1/realtime",key:"Bearer " + rotatedKey},
      ]);
      for (const [Client, apiKey] of [[sdk.UserClient, orgKey], [sdk.OrganizationClient, "ag9_oak." + "key." + "x".repeat(32)]]) {
        assert.throws(() => new Client({baseUrl,apiKey}), (error) => {
          assert(error instanceof TypeError);
          assert(!String(error).includes(apiKey));
          assert(!JSON.stringify(error).includes(apiKey));
          return true;
        });
      }
      assert.equal(requests.length, 7);
      for (const client of [org, user]) {
        for (const key of [orgKey, userKey, rotatedKey]) assert(!JSON.stringify(client).includes(key));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  `,
  );
  execFileSync(process.execPath, ["consumer.mjs"], {
    cwd: temporary,
    stdio: "pipe",
  });
});
