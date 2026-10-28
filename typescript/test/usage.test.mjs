import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import {
  UserClient,
  OrganizationClient,
  TiDBLinkApiError,
} from "../dist/index.js";

const servers = [];
after(async () =>
  Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))),
);
const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const userKey = "ti_user_key_" + "x".repeat(43);
const orgKey = "ti_org_key_" + "o".repeat(43);
const json = (res, body, status = 200) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));

test("User usage keeps self authority, inclusive dates and unknown valuation without recomputing totals", async () => {
  const requests = [];
  const summary = {
    scope: { level: "user", organizationId: "org_1", userId: "user_1" },
    range: { from: "2030-01-01", to: "2030-01-01", period: "day" },
    factCompleteness: { status: "incomplete", pendingIntentCount: 1 },
    totals: {
      totalCostMicros: 123,
      unknownLlmRequestCount: 1,
      valuation: { status: "incomplete", unpricedUsageCount: 2 },
    },
  };
  const baseUrl = await serve((req, res) => {
    requests.push({ url: req.url, key: req.headers.authorization });
    json(res, summary);
  });
  const user = new UserClient({ baseUrl, apiKey: userKey });
  assert.deepEqual(
    await user.getUsage({
      from: "2030-01-01",
      to: "2030-01-01",
      period: "day",
      tagKey: "team",
      tagValue: "研发 & Growth",
    }),
    summary,
  );
  const url = new URL(requests[0].url, baseUrl);
  assert.equal(url.pathname, "/api/v1/billing/usage");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    from: "2030-01-01",
    to: "2030-01-01",
    period: "day",
    tagKey: "team",
    tagValue: "研发 & Growth",
  });
  assert.equal(requests[0].key, `Bearer ${userKey}`);
});

test("Organization usage targets an explicit User and retains cursor, exact range and distinct detail projection", async () => {
  const requests = [];
  const details = {
    items: [
      {
        kind: "llm",
        id: "usage_1",
        costMicros: null,
        valuationStatus: "unpriced",
        pricingStatus: "unknown",
        valuationReason: "no_rate_authority",
        turnId: null,
        realtimeConnectionId: "voice_1",
        billingTag: null,
      },
    ],
    nextCursor: "opaque/+?cursor",
    factCompleteness: { status: "incomplete", indeterminateIntentCount: 1 },
  };
  const aggregate = {
    range: {
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-01-02T00:00:00.000Z",
      interval: "hour",
    },
    totals: { totalCostMicros: 12 },
    series: [],
  };
  const baseUrl = await serve((req, res) => {
    requests.push({ url: req.url, key: req.headers.authorization });
    json(res, req.url.includes("/details") ? details : aggregate);
  });
  const org = new OrganizationClient({ baseUrl, apiKey: orgKey });
  const range = {
    from: "2030-01-01T00:00:00.000Z",
    to: "2030-01-02T00:00:00.000Z",
  };
  assert.deepEqual(
    await org.getUserUsage("user_1", { ...range, interval: "hour" }),
    aggregate,
  );
  assert.deepEqual(
    await org.getUserUsageDetails("user_1", {
      ...range,
      kind: "llm",
      limit: 1,
      cursor: "opaque/+?cursor",
      tagKey: "team",
      tagValue: "R&D",
    }),
    details,
  );
  const url = new URL(requests[1].url, baseUrl);
  assert.equal(url.pathname, "/api/v1/org/users/user_1/billing/usage/details");
  assert.equal(url.searchParams.get("cursor"), "opaque/+?cursor");
  assert.equal(url.searchParams.get("tagValue"), "R&D");
  assert.equal(url.searchParams.get("from"), range.from);
  assert.equal(url.searchParams.get("limit"), "1");
  assert(requests.every((request) => request.key === `Bearer ${orgKey}`));
});

test("self details retain separate limited arrays and nullable fields without inventing continuation", async () => {
  const details = {
    scope: { level: "user", organizationId: "org_1", userId: "user_1" },
    range: { period: "day", from: "2030-01-01", to: "2030-01-01" },
    llm: [
      {
        kind: "llm",
        costMicros: null,
        pricingStatus: "unknown",
        unknownReason: "no_rate_authority",
        estimateBasis: null,
        deploymentBillingJson: null,
      },
    ],
    sandbox: [
      {
        kind: "sandbox",
        endedAt: null,
        durationSeconds: null,
        costMicros: null,
        valuationStatus: "unpriced",
      },
    ],
    webSearch: [],
  };
  let url;
  const baseUrl = await serve((req, res) => {
    url = new URL(req.url, "http://localhost");
    json(res, details);
  });
  assert.deepEqual(
    await new UserClient({ baseUrl, apiKey: userKey }).getUsageDetails({
      limit: 1,
    }),
    details,
  );
  assert.equal(url.pathname, "/api/v1/billing/usage/details");
  assert.equal(url.searchParams.get("limit"), "1");
  assert.equal("nextCursor" in details, false);
});

test("unsupported self scope or cursor and missing Organization target cannot dispatch a read", async () => {
  let requests = 0;
  const baseUrl = await serve((_req, res) => {
    requests++;
    json(res, {});
  });
  const user = new UserClient({ baseUrl, apiKey: userKey });
  const org = new OrganizationClient({ baseUrl, apiKey: orgKey });
  for (const options of [
    { userId: "other" },
    { scope: "organization" },
    { cursor: "not-supported" },
  ])
    assert.throws(() => user.getUsageDetails(options), TypeError);
  assert.throws(() => org.getUserUsage("", { from: "a", to: "b" }), TypeError);
  assert.throws(() => org.getUserUsage("user_1", {}), TypeError);
  assert.throws(
    () =>
      org.getUserUsageDetails("user_1", {
        from: "a",
        to: "b",
        interval: "hour",
      }),
    TypeError,
  );
  assert.equal(requests, 0);
});

test("invalid range, mismatched cursor and foreign target preserve service refusals", async () => {
  for (const [status, code] of [
    [400, "invalid_billing_usage_query"],
    [400, "invalid_billing_usage_cursor"],
    [404, "billing_target_not_found"],
  ]) {
    const baseUrl = await serve((_req, res) =>
      json(
        res,
        { error: { code, message: "Refused", requestId: "usage-read-1" } },
        status,
      ),
    );
    const org = new OrganizationClient({ baseUrl, apiKey: orgKey });
    await assert.rejects(
      org.getUserUsageDetails("user_1", {
        from: "2030-01-01T00:00:00.000Z",
        to: "2030-01-02T00:00:00.000Z",
        cursor: "foreign",
      }),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.code === code &&
        error.status === status &&
        error.requestId === "usage-read-1",
    );
  }
});
