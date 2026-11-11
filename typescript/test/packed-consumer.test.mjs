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
  assert(files.includes("examples/prepare-realtime-connection.mjs"));
  assert(files.includes("examples/create-session.mjs"));
  assert(files.includes("examples/send-message.mjs"));
  assert(files.includes("examples/read-usage.mjs"));
  assert(files.includes("examples/control-turn.mjs"));
  assert(files.includes("examples/upload-file.mjs"));
  assert(files.includes("examples/schedule-task.mjs"));
  assert(files.includes("examples/submit-audio.mjs"));
  assert(files.includes("examples/observe-message.mjs"));
  assert(files.includes("examples/answer-client-tool.mjs"));
  assert(!files.some((file) => file.includes("workspace")));
  assert(
    files.every(
      (file) =>
        file === "LICENSE" ||
        file === "README.md" ||
        file === "package.json" ||
        file === "examples/prepare-realtime-connection.mjs" ||
        file === "examples/create-session.mjs" ||
        file === "examples/send-message.mjs" ||
        file === "examples/read-usage.mjs" ||
        file === "examples/control-turn.mjs" ||
        file === "examples/upload-file.mjs" ||
        file === "examples/schedule-task.mjs" ||
        file === "examples/submit-audio.mjs" ||
        file === "examples/observe-message.mjs" ||
        file === "examples/answer-client-tool.mjs" ||
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
      AudioTurnInput, AudioTurnEvent, AudioTurnResult,
      Scheduler, SchedulerResponse, SchedulerFirePage, SchedulerPage, CreateSchedulerInput,
      UserFile, FileUploadCapabilities, FileUpload, FileUploadStatus,
      FileUploadPart, UploadedFilePart, FilePage, FileContent, FileDownloadGrant,
      Agent, EndUserClient, BillingPrincipalBucket,
      AgentRecord,
      AgentTemplatePage,
      AgentModelCatalog,
      SessionPage,
      CreateSessionOptions,
      Organization,
      EndUser,
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
      OrganizationUserUsageSummary, OrganizationUserUsageDetails,
      OrganizationUserUsageOptions, OrganizationUserUsageDetailsOptions,
      TurnCommandInput,
      RetryReceipt,
      SessionEvent, SessionEventsOptions, ObserveTurnOptions, TurnObservation,
      ClientToolDeclaration, ClientToolSet, ReplaceClientToolsOptions, PendingClientToolCall, ClientToolOutputInput,
    } from "@tidblink/server";
    import {
      TIDB_LINK_API_VERSION,
      TIDB_LINK_REVISION,
      OutcomeUnknownError,
      ObservationStoppedError,
      TurnWaitTimeoutError,
      TurnFailedError,
      TurnInterruptedError,
      InputNotAppliedError,
      TiDBLinkApiError,
      TiDBLinkError,
      OrganizationClient,
    } from "@tidblink/server";
    // @ts-expect-error Previous compatibility constants and error exports have no aliases.
    import { AGENT_SERVICE_API_VERSION, AGENT_SERVICE_REVISION, AgentStackError, AgentStackApiError } from "@tidblink/server";
    // @ts-expect-error Workspace authority was removed from the supported SDK.
    import { WorkspaceClient } from "@tidblink/server";
    // @ts-expect-error User API Key authority was removed from the supported SDK.
    import { UserClient } from "@tidblink/server";

    declare const baseUrl: string;
    declare const organizationApiKey: string;
    const organization = new OrganizationClient({ baseUrl, apiKey: organizationApiKey });
    const owner: EndUserClient = organization.user("user_1");
    const orgAgent: Promise<Agent> = owner.getAgent("agent_1");
    const deleted: Promise<SchedulerPage> = owner.schedulers.list({ status: "deleted" });
    const principal: BillingPrincipalBucket = "organization_user";
    // @ts-expect-error User API Key management was removed with User authority.
    organization.createUserApiKey("user_1", { name: "backend" });
    async function provisionEndUser(): Promise<EndUser> {
      const current: Organization = await organization.getOrganization();
      const created: EndUser = await organization.createEndUser({
        externalId: "customer_1", displayName: "Customer",
      });
      const users: EndUser[] = await organization.listEndUsers();
      const found: EndUser = await organization.getEndUser(created.userId);
      void current; void users;
      return found;
    }
    async function clientToolsWorkflow(session: Session, agent: Agent) {
      const tool: ClientToolDeclaration = {type:"function",name:"lookup_order",description:"Read an order",parameters:{type:"object",properties:{orderId:{type:"string"}}}};
      const created: Session = await agent.createSession({idempotencyKey:"tools-session",tools:[tool]});
      const set: ClientToolSet = await session.getClientTools();
      const options: ReplaceClientToolsOptions = {ifMatch:set.etag};
      const replaced: ClientToolSet = await session.replaceClientTools([],options);
      const calls: PendingClientToolCall[] = await session.listPendingClientToolCalls();
      const input: ClientToolOutputInput = {clientEventId:"output-1",turnId:calls[0]!.turnId,callId:calls[0]!.callId,output:"shipped"};
      const receipt: SessionInteraction = await session.submitClientToolOutput(input);
      await session.submitClientToolOutput({clientEventId:"failure-1",turnId:input.turnId,callId:input.callId,error:{message:"Unavailable"}});
      // @ts-expect-error A result is either output or error.
      const invalid: ClientToolOutputInput = {clientEventId:"bad",turnId:"turn",callId:"call",output:"ok",error:{message:"failed"}};
      void created; void replaced; void receipt; void invalid;
    }
    async function controlWorkflow(session: Session): Promise<TurnResult> {
      const input: TurnCommandInput = { clientEventId: "cancel-command", turnId: "turn" };
      const cancellation: SessionInteraction = await session.cancel(input);
      const retried: RetryReceipt = await session.retry({ ...input, clientEventId: "retry-command" });
      void cancellation;
      return session.waitForResult(retried.clientEventId);
    }
    async function audioWorkflow(session: Session): Promise<AudioTurnResult> {
      const input: AudioTurnInput = {bytes:new Uint8Array([1]),filename:"voice.wav",contentType:"audio/wav",billingTag:null};
      for await (const event of session.streamAudio(input)) {
        const typed: AudioTurnEvent = event;
        if (typed.event === "turn_finished") { const status: "succeeded" | "failed" | "interrupted" = typed.payload.status; void status; }
      }
      // @ts-expect-error Audio does not accept ordinary input identities or promise text replay.
      session.audio({...input,clientEventId:"text-only"});
      return session.audio(input);
    }
    async function schedulerWorkflow(user: EndUserClient): Promise<Scheduler> {
      const input: CreateSchedulerInput = {agentId:"agent-1",title:"Report",prompt:"Summarize",schedule:{kind:"once",after:"1h"},idempotencyKey:"scheduler-1"};
      const created: SchedulerResponse = await user.schedulers.create(input);
      const bound: CreateSchedulerInput = {delivery:{target:"bound_session",sessionId:"session-1"},title:"Report",prompt:"Summarize",schedule:{kind:"cron",cronExpr:"0 9 * * *",timezone:"Asia/Shanghai"},idempotencyKey:"scheduler-2"};
      await user.schedulers.create(bound);
      // @ts-expect-error A once schedule takes exactly one time form.
      const invalid: CreateSchedulerInput = {...input,schedule:{kind:"once",after:"1h",runAt:"2099-01-01T00:00:00.000Z"}};
      const current = await user.schedulers.get(created.scheduler.schedulerId);
      const updated = await user.schedulers.update(current.scheduler.schedulerId,{enabled:false,validUntil:null},{ifMatch:current.etag});
      const list: SchedulerPage = await user.schedulers.list({status:"disabled",limit:1});
      const fires: SchedulerFirePage = await user.schedulers.fires(current.scheduler.schedulerId,{limit:1});
      await user.schedulers.delete(current.scheduler.schedulerId,{ifMatch:updated.etag});
      void invalid; void list; void fires;
      return current.scheduler;
    }
    async function fileWorkflow(user: EndUserClient): Promise<UserFile> {
      const capabilities: FileUploadCapabilities = await user.files.capabilities();
      const intent: FileUpload = await user.files.createUpload({originalName:"empty", byteSize:0, sha256:"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", contentType:null,idempotencyKey:"empty-file"});
      const status: FileUploadStatus = await user.files.getUpload(intent.uploadId);
      const part: FileUploadPart = await user.files.presignPart(intent.uploadId,1,"a".repeat(64));
      const uploaded: UploadedFilePart = await user.files.uploadPart(part,new Uint8Array());
      await user.files.completeUpload(intent.uploadId,[uploaded]);
      const page: FilePage = await user.files.list({history:true,limit:1});
      const content: FileContent = await user.files.getContent(intent.file.fileId);
      if(content.type === "download") { const grant: FileDownloadGrant = content.grant; await user.files.downloadFromGrant(grant); }
      await user.files.download(intent.file.fileId);
      await user.files.cancelUpload(intent.uploadId);
      void capabilities; void status; void page;
      return user.files.upload({originalName:"empty",bytes:new Uint8Array(),idempotencyKey:"another-file"});
    }
    async function progressWorkflow(session: Session) {
      const options: SessionEventsOptions = {cursor: "saved-position"};
      for await (const event of session.events(options)) {
        const typed: SessionEvent = event;
        void typed;
      }
      const observation: ObserveTurnOptions = {timeoutMs: 15000};
      for await (const update of session.observe("original-input", observation)) {
        const typed: TurnObservation = update;
        if (typed.type === "draft" || typed.type === "progress") {const text: string = typed.text; void text;}
        if (typed.type === "result") {const result: TurnResult = typed.result; void result;}
      }
      const stopped = new ObservationStoppedError("Stopped", {sessionId: session.id, inputId: "original-input", cursor: "saved-position"});
      const cursor: string | undefined = stopped.cursor;
      void cursor;
    }
    async function usageWorkflow() {
      const range: OrganizationUserUsageOptions = {from:"2030-01-02T00:00:00.000Z",to:"2030-01-03T00:00:00.000Z",interval:"hour"};
      const target: OrganizationUserUsageSummary = await organization.getUserUsage("user_1",range);
      const pageOptions: OrganizationUserUsageDetailsOptions = {from:range.from,to:range.to,kind:"llm",limit:1};
      const page: OrganizationUserUsageDetails = await organization.getUserUsageDetails("user_1",pageOptions);
      const cost: number | null | undefined = page.items[0]?.costMicros;
      const cursor: string | null = page.nextCursor;
      // @ts-expect-error Usage is read through the Organization client with an explicit target.
      await owner.getUsage(range);
      // @ts-expect-error Organization aggregate requires an explicit target User.
      await organization.getUserUsage(range);
      void target;void cost;void cursor;
    }
    async function lifecycleWorkflow(): Promise<Session> {
      const user = owner;
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
      const user = owner;
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
    // @ts-expect-error The owner is selected with organization.user(), not a client option.
    new OrganizationClient({ baseUrl, apiKey: organizationApiKey, userId: "user_1" });
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
    void textWorkflow; void recover;
    void TIDB_LINK_API_VERSION;
    void TIDB_LINK_REVISION;
    const apiError: TiDBLinkError = new TiDBLinkApiError({ status: 400, code: "test", message: "safe" });
    void apiError;
    void WorkspaceClient;
    void UserClient;
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
    "@tidblink",
    "server",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(installedPackage.dependencies, undefined);
  assert.equal(installedPackage.tidbLinkApiVersion, "0.0.1");
  assert.equal(
    installedPackage.tidbLinkRevision,
    "882287809f91d9a3fdf60537460431d9f0fc23e7",
  );
  assert.equal(
    installedPackage.tidbLinkOpenApiSha256,
    "906515e4c8d38c5ac9fce6390d9d646220b2d06100fbcb64e180419899989a5b",
  );
  for (const prefix of ["Provisioning", "Realtime", "Lifecycle", "Text"]) {
    assert.equal("tidbLink" + prefix + "Revision" in installedPackage, false);
    assert.equal("tidbLink" + prefix + "OpenApiSha256" in installedPackage, false);
  }
  assert.equal(installedPackage.name, "@tidblink/server");
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
    import * as sdk from "@tidblink/server";
    assert.equal(sdk.TIDB_LINK_API_VERSION, "0.0.1");
    assert.equal(sdk.TIDB_LINK_REVISION, ${JSON.stringify(installedPackage.tidbLinkRevision)});
    const { prepareRealtimeConnection } = await import("@tidblink/server/examples/prepare-realtime-connection.mjs");
    const { readUserUsage } = await import("@tidblink/server/examples/read-usage.mjs");
    assert.equal(typeof readUserUsage,"function");
    const { sendMessageWorkflow } = await import("@tidblink/server/examples/send-message.mjs");
    assert.equal(typeof sendMessageWorkflow,"function");
    const { uploadFileWorkflow } = await import("@tidblink/server/examples/upload-file.mjs");
    assert.equal(typeof uploadFileWorkflow,"function");
    const { scheduleTaskWorkflow } = await import("@tidblink/server/examples/schedule-task.mjs");
    assert.equal(typeof scheduleTaskWorkflow,"function");
    const { submitAudioWorkflow } = await import("@tidblink/server/examples/submit-audio.mjs");
    assert.equal(typeof submitAudioWorkflow,"function");
    const { observeMessageWorkflow } = await import("@tidblink/server/examples/observe-message.mjs");
    assert.equal(typeof observeMessageWorkflow,"function");
    const { answerClientToolWorkflow } = await import("@tidblink/server/examples/answer-client-tool.mjs");
    assert.equal(typeof answerClientToolWorkflow,"function");
    const { createSessionWorkflow } = await import("@tidblink/server/examples/create-session.mjs");
    assert.equal(typeof createSessionWorkflow, "function");
    assert.equal(typeof prepareRealtimeConnection, "function");
    assert.equal(sdk.ServiceUser, undefined);
    assert.equal(sdk.UserClient, undefined);
    for (const name of ["AGENT_SERVICE_API_VERSION", "AGENT_SERVICE_REVISION", "AgentStackError", "AgentStackApiError", "TIDB_LINK_PROVISIONING_REVISION", "TIDB_LINK_REALTIME_REVISION", "TIDB_LINK_LIFECYCLE_REVISION", "TIDB_LINK_TEXT_REVISION"]) {
      assert.equal(sdk[name], undefined);
    }
    const orgKey = "ti_org_key_" + "x".repeat(43);
    const userKey = "ti_user_key_" + "y".repeat(43);
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url, key: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/org/users/user_1/agents") {
        response.end(JSON.stringify({ agents: [] }));
      } else if (request.url === "/api/v1/org/users/user_1/realtime-models") {
        response.end(JSON.stringify({
          defaultModel: "voice-a",
          models: [{ id: "voice-a", label: "Voice A", available: true, isDefault: true, languages: ["en-US"], endpointingModes: ["client"], audio: { input: [], output: [] } }],
        }));
      } else if (request.url === "/api/v1/org/users/user_1/sessions/session_1") {
        response.end(JSON.stringify({ session: {
          realtimeModel: "voice-a", realtimeModelRevision: 1,
          realtimeModelEtag: "realtime-v1", realtimeVoice: { language: "en-US" },
        } }));
      } else if (request.url === "/api/v1/org/users/user_1/sessions/session_1/realtime") {
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
        response.writeHead(404).end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = "http://127.0.0.1:" + server.address().port;
      const org = new sdk.OrganizationClient({ baseUrl, apiKey: orgKey });
      const user = org.user("user_1");
      assert.deepEqual(await user.listAgents(), []);
      const prepared = await prepareRealtimeConnection({
        baseUrl,
        organizationApiKey: orgKey,
        userId: "user_1",
        sessionId: "session_1",
      });
      assert.equal(prepared.realtimeConnection.id, "rtc_1");
      assert.match(prepared.connectToken, /^rct_/);
      assert.equal(JSON.stringify(user).includes(prepared.connectToken), false);
      assert.deepEqual(requests, [
        {method:"GET",url:"/api/v1/org/users/user_1/agents",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/v1/org/users/user_1/realtime-models",key:"Bearer " + orgKey},
        {method:"GET",url:"/api/v1/org/users/user_1/sessions/session_1",key:"Bearer " + orgKey},
        {method:"POST",url:"/api/v1/org/users/user_1/sessions/session_1/realtime",key:"Bearer " + orgKey},
      ]);
      for (const apiKey of [userKey, "ag9_oak." + "key." + "x".repeat(32)]) {
        assert.throws(() => new sdk.OrganizationClient({baseUrl,apiKey}), (error) => {
          assert(error instanceof TypeError);
          assert(!String(error).includes(apiKey));
          assert(!JSON.stringify(error).includes(apiKey));
          return true;
        });
      }
      assert.equal(requests.length, 4);
      for (const client of [org, user]) assert(!JSON.stringify(client).includes(orgKey));
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
