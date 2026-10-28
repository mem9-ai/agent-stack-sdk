import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UserClient,
  OrganizationClient,
  TiDBLinkApiError,
} from "@mem9/tidb-link";

import {
  readOwnUsage,
  readUserUsage,
} from "@mem9/tidb-link/examples/read-usage.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const user = new UserClient({ baseUrl, apiKey: process.env.SDK_USER_KEY });
const organization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
});
const userId = process.env.SDK_USAGE_USER_ID;
const tag = { tagKey: "cost_center", tagValue: "Café/QA" };
const userRange = {
  from: "2030-01-02",
  to: "2030-01-02",
  period: "day",
  ...tag,
};
const range = {
  from: "2030-01-02T00:00:00.000Z",
  to: "2030-01-03T00:00:00.000Z",
  ...tag,
};

test("actual User usage keeps its self projection and unknown, unpriced and incomplete facts", async () => {
  const summary = await user.getUsage(userRange);
  assert.equal(summary.scope.level, "user");
  assert.equal(summary.scope.userId, userId);
  assert.equal(summary.range.from, userRange.from);
  assert.equal(summary.range.to, userRange.to);
  assert.equal(summary.totals.totalCostMicros, 1000);
  assert.equal(summary.totals.unknownLlmRequestCount, 2);
  assert.equal(summary.totals.valuation.status, "incomplete");
  assert.equal(summary.factCompleteness.status, "incomplete");
  assert.equal(summary.factCompleteness.indeterminateIntentCount, 1);
  const detail = await user.getUsageDetails({ ...userRange, limit: 10 });
  assert.equal(detail.llm.length, 3);
  assert.equal(
    detail.llm.find((row) => row.id === "sdk_usage_unknown").costMicros,
    null,
  );
  const stale = detail.llm.find((row) => row.id === "sdk_usage_stale_cost");
  assert.equal(stale.costMicros, 99000);
  assert.equal(stale.valuationStatus, "unpriced");
  assert.equal(stale.pricingStatus, "unknown");
  assert.equal(detail.sandbox[0].durationSeconds, null);
  assert.equal(detail.sandbox[0].endedAt, null);
  assert.equal(detail.webSearch[0].pricingStatus, "unpriced");
  assert.equal(detail.webSearch[0].returnedResultCount, null);
  assert.equal("nextCursor" in detail, false);
  assert.equal(
    (await user.getUsageDetails({ ...userRange, limit: 1 })).llm.length,
    1,
  );
  assert.equal(
    (await user.getUsage({ ...userRange, tagValue: "café/qa" })).totals
      .llmRequestCount,
    0,
  );
  assert.equal(
    (await user.getUsage({ from: "2030-01-03", to: "2030-01-03" })).totals
      .llmRequestCount,
    0,
  );
});

test("actual Organization target-User reads preserve exact range, global pages and private-field omission", async () => {
  const summary = await organization.getUserUsage(userId, {
    ...range,
    interval: "hour",
  });
  assert.equal(summary.range.interval, "hour");
  assert.equal(summary.totals.totalCostMicros, 1000);
  assert.equal(summary.factCompleteness.status, "incomplete");
  assert.equal("scope" in summary, false);
  assert.equal("users" in summary, false);
  const items = [];
  let cursor;
  do {
    const page = await organization.getUserUsageDetails(userId, {
      ...range,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.factCompleteness.status, "incomplete");
    items.push(...page.items);
    assert.notEqual(page.nextCursor, cursor);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(items.length, 5);
  assert.equal(new Set(items.map((item) => item.id)).size, 5);
  const unknown = items.find((item) => item.id === "sdk_usage_unknown");
  assert.equal(unknown.costMicros, null);
  assert.equal(unknown.valuationReason, "provider_usage_missing");
  assert.equal("ownerUserId" in unknown, false);
  assert.equal("usageRawJson" in unknown, false);
  assert.equal("deploymentBillingJson" in unknown, false);
  const llm = await organization.getUserUsageDetails(userId, {
    ...range,
    kind: "llm",
    limit: 1,
  });
  assert.equal(llm.items[0].kind, "llm");
  assert(llm.nextCursor);
  await assert.rejects(
    organization.getUserUsageDetails(userId, {
      ...range,
      kind: "sandbox",
      cursor: llm.nextCursor,
    }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "invalid_billing_usage_cursor",
  );
  await assert.rejects(
    organization.getUserUsage(userId, {
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-03-01T00:00:00.000Z",
    }),
    (error) =>
      error instanceof TiDBLinkApiError &&
      error.code === "invalid_billing_usage_query",
  );
});

test("actual usage separates Users and refuses foreign or missing Organization targets", async () => {
  const stranger = new UserClient({
    baseUrl,
    apiKey: process.env.SDK_FOREIGN_USER_KEY,
  });
  const own = await stranger.getUsage(userRange);
  assert.equal(own.scope.userId, process.env.SDK_USAGE_STRANGER_ID);
  assert.equal(own.totals.totalCostMicros, 3333);
  assert.equal(own.factCompleteness.status, "complete");
  assert.throws(() => stranger.getUsage({ ...userRange, userId }), TypeError);
  const foreign = new OrganizationClient({
    baseUrl,
    apiKey: process.env.SDK_FOREIGN_ORGANIZATION_KEY,
  });
  for (const client of [foreign, organization]) {
    const target = client === foreign ? userId : "user_not_present";
    await assert.rejects(
      client.getUserUsage(target, range),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.status === 404 &&
        error.code === "billing_target_not_found",
    );
    await assert.rejects(
      client.getUserUsageDetails(target, range),
      (error) =>
        error instanceof TiDBLinkApiError &&
        error.status === 404 &&
        error.code === "billing_target_not_found",
    );
  }
});

test("the installed usage examples preserve both public projections", async () => {
  const own = await readOwnUsage({
    baseUrl,
    userApiKey: process.env.SDK_USER_KEY,
    options: userRange,
  });
  const target = await readUserUsage({
    baseUrl,
    organizationApiKey: process.env.SDK_ORGANIZATION_KEY,
    userId,
    options: { ...range, interval: "hour" },
  });
  assert.equal(own.summary.totals.totalCostMicros, 1000);
  assert.equal(own.details.llm.length, 3);
  assert.equal(target.summary.totals.totalCostMicros, 1000);
  assert.equal(target.details.items.length, 5);
});
