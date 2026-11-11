import assert from "node:assert/strict";
import { test } from "node:test";
import { OrganizationClient, TiDBLinkApiError } from "@tidblink/server";

import { readUserUsage } from "@tidblink/server/examples/read-usage.mjs";

const baseUrl = process.env.SDK_SERVICE_URL;
const organization = new OrganizationClient({
  baseUrl,
  apiKey: process.env.SDK_ORGANIZATION_KEY,
});
const userId = process.env.SDK_USER_ID;
const tag = { tagKey: "cost_center", tagValue: "Café/QA" };
const range = {
  from: "2030-01-02T00:00:00.000Z",
  to: "2030-01-03T00:00:00.000Z",
  ...tag,
};

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
  const other = await organization.getUserUsage(
    process.env.SDK_FOREIGN_USER_ID,
    range,
  );
  assert.equal(other.totals.totalCostMicros, 3333);
  assert.equal(other.factCompleteness.status, "complete");
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

test("the installed usage example preserves the Organization projection", async () => {
  const target = await readUserUsage({
    baseUrl,
    organizationApiKey: process.env.SDK_ORGANIZATION_KEY,
    userId,
    options: { ...range, interval: "hour" },
  });
  assert.equal(target.summary.totals.totalCostMicros, 1000);
  assert.equal(target.details.items.length, 5);
});
