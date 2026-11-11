import assert from "node:assert/strict";
import test from "node:test";

import {
  changelogSection,
  describePlan,
  planRelease,
  releaseNotes,
} from "./release-plan.mjs";

const name = "@tidblink/server";
const changelog = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- Work in progress.",
  "",
  "## 0.4.0-rc.1",
  "",
  "- Candidate change.",
  "",
  "## 0.3.0 (2026-11-12)",
  "",
  "- First change.",
  "- Second change.",
  "",
  "## 0.2.0",
  "",
  "- Older change.",
  "",
].join("\n");

const plan = (version, state = {}) =>
  planRelease({
    name,
    version,
    changelog,
    tagExists: false,
    published: false,
    draftExists: false,
    ...state,
  });

test("reads only the requested version section", () => {
  assert.equal(
    changelogSection(changelog, "0.3.0"),
    "- First change.\n- Second change.",
  );
  assert.equal(changelogSection(changelog, "0.2.0"), "- Older change.");
  assert.equal(changelogSection(changelog, "0.3"), null);
  assert.equal(changelogSection(changelog, "0.4.0"), null);
});

test("a version without its own section is still in development", () => {
  const result = plan("0.5.0");
  assert.equal(result.action, "none");
  assert.match(describePlan(result), /^No release: .*still in development/);
});

test("an existing tag is never released again", () => {
  const result = plan("0.3.0", { tagExists: true, published: true });
  assert.equal(result.action, "none");
  assert.match(result.reason, /@tidblink\/server@0\.3\.0 already exists/);
});

test("a new version is staged: stable to latest, prerelease to next", () => {
  const stable = plan("0.3.0");
  assert.deepEqual(
    [stable.action, stable.distTag, stable.prerelease, stable.tag],
    ["stage", "latest", false, "@tidblink/server@0.3.0"],
  );
  const candidate = plan("0.4.0-rc.1");
  assert.deepEqual(
    [candidate.action, candidate.distTag, candidate.prerelease],
    ["stage", "next", true],
  );
  assert.match(describePlan(candidate), /only after a maintainer approves/);
});

test("a staged version waits for approval and is not staged twice", () => {
  assert.equal(plan("0.3.0", { draftExists: true }).action, "await");
});

test("an approved version is finalized with or without a draft", () => {
  assert.equal(
    plan("0.3.0", { published: true, draftExists: true }).action,
    "finalize",
  );
  assert.equal(plan("0.3.0", { published: true }).action, "finalize");
});

test("rejects invalid versions and empty sections", () => {
  assert.throws(() => plan("v0.3.0"), /not a SemVer version/);
  assert.throws(
    () =>
      planRelease({
        name,
        version: "0.6.0",
        changelog: "## 0.6.0\n\n## 0.5.0\n\n- Change.\n",
        tagExists: false,
        published: false,
        draftExists: false,
      }),
    /is empty/,
  );
});

test("release notes record the service compatibility mapping", () => {
  const notes = releaseNotes(
    plan("0.3.0"),
    {
      tidbLinkRevision: "abc123",
      tidbLinkOpenApiSha256: "def456",
      tidbLinkApiVersion: "0.0.1",
    },
    "0123abcd",
  );
  assert.match(notes, /^- First change\.\n- Second change\./);
  assert.match(notes, /`@tidblink\/server@0\.3\.0` \(npm dist-tag `latest`\)/);
  assert.match(notes, /SDK commit: `0123abcd`/);
  assert.match(notes, /service baseline: `abc123`/);
  assert.match(notes, /OpenAPI SHA-256: `def456`/);
});
