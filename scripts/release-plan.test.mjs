import assert from "node:assert/strict";
import test from "node:test";

import {
  changelogSection,
  planRelease,
  releaseNotes,
} from "./release-plan.mjs";

const name = "@tidblink/sdk";
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
  const plan = planRelease({
    name,
    version: "0.5.0",
    changelog,
    tagExists: false,
  });
  assert.equal(plan.release, false);
  assert.match(plan.reason, /still in development/);
});

test("an existing tag is never released again", () => {
  const plan = planRelease({
    name,
    version: "0.3.0",
    changelog,
    tagExists: true,
  });
  assert.equal(plan.release, false);
  assert.match(plan.reason, /typescript-v0\.3\.0 already exists/);
});

test("stable versions go to latest and prereleases to next", () => {
  const stable = planRelease({
    name,
    version: "0.3.0",
    changelog,
    tagExists: false,
  });
  assert.deepEqual(
    [stable.release, stable.distTag, stable.prerelease, stable.tag],
    [true, "latest", false, "typescript-v0.3.0"],
  );
  const candidate = planRelease({
    name,
    version: "0.4.0-rc.1",
    changelog,
    tagExists: false,
  });
  assert.deepEqual(
    [candidate.release, candidate.distTag, candidate.prerelease],
    [true, "next", true],
  );
});

test("rejects invalid versions and empty sections", () => {
  assert.throws(
    () => planRelease({ name, version: "v0.3.0", changelog, tagExists: false }),
    /not a SemVer version/,
  );
  assert.throws(
    () =>
      planRelease({
        name,
        version: "0.6.0",
        changelog: "## 0.6.0\n\n## 0.5.0\n\n- Change.\n",
        tagExists: false,
      }),
    /is empty/,
  );
});

test("release notes record the service compatibility mapping", () => {
  const plan = planRelease({
    name,
    version: "0.3.0",
    changelog,
    tagExists: false,
  });
  const notes = releaseNotes(
    plan,
    {
      tidbLinkRevision: "abc123",
      tidbLinkOpenApiSha256: "def456",
      tidbLinkApiVersion: "0.0.1",
    },
    "0123abcd",
  );
  assert.match(notes, /^- First change\.\n- Second change\./);
  assert.match(notes, /`@tidblink\/sdk@0\.3\.0` \(npm dist-tag `latest`\)/);
  assert.match(notes, /SDK commit: `0123abcd`/);
  assert.match(notes, /service baseline: `abc123`/);
  assert.match(notes, /OpenAPI SHA-256: `def456`/);
});
