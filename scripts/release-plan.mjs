// Decides what the release workflow should do with the TypeScript package on
// this commit. A version is released when CHANGELOG.md has its own section and
// the version has no release tag yet. See RELEASING.md.
//
//   stage     submit the version to npm for a maintainer's approval
//   await     already submitted; a maintainer has not approved it yet
//   finalize  approved and public on npm; create the tag and GitHub Release
//   none      nothing to release
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** One tag per package and version, so packages in this repository release independently. */
export const releaseTag = (name, version) => `${name}@${version}`;

/** Returns the body of the `## <version>` section, or null when it is absent. */
export const changelogSection = (changelog, version) => {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## ${version} `),
  );
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
};

export const planRelease = ({
  name,
  version,
  changelog,
  tagExists,
  published,
  draftExists,
}) => {
  if (!SEMVER.test(version))
    throw new Error(`Package version "${version}" is not a SemVer version`);
  const prerelease = version.includes("-");
  const base = {
    name,
    version,
    tag: releaseTag(name, version),
    prerelease,
    distTag: prerelease ? "next" : "latest",
  };
  if (tagExists)
    return { ...base, action: "none", reason: `${base.tag} already exists` };
  const notes = changelogSection(changelog, version);
  if (notes === null)
    return {
      ...base,
      action: "none",
      reason: `CHANGELOG.md has no "## ${version}" section, so ${version} is still in development`,
    };
  if (!notes)
    throw new Error(`CHANGELOG.md section "## ${version}" is empty`);
  if (published) return { ...base, action: "finalize", notes };
  return { ...base, action: draftExists ? "await" : "stage", notes };
};

export const describePlan = (plan) => {
  const target = `\`${plan.name}@${plan.version}\``;
  switch (plan.action) {
    case "stage":
      return `Stage ${target} on npm with dist-tag \`${plan.distTag}\`. It becomes public only after a maintainer approves it on npm.`;
    case "await":
      return `${target} is staged on npm and waits for a maintainer's approval.`;
    case "finalize":
      return `${target} is public on npm. Create \`${plan.tag}\` and publish its GitHub Release.`;
    default:
      return `No release: ${plan.reason}.`;
  }
};

export const releaseNotes = (plan, manifest, commit) =>
  [
    plan.notes,
    "",
    "## Compatibility",
    "",
    `- Package: \`${plan.name}@${plan.version}\` (npm dist-tag \`${plan.distTag}\`)`,
    `- SDK commit: \`${commit}\``,
    `- TiDB Link service baseline: \`${manifest.tidbLinkRevision}\``,
    `- Source OpenAPI SHA-256: \`${manifest.tidbLinkOpenApiSha256}\``,
    `- TiDB Link API: \`${manifest.tidbLinkApiVersion}\``,
    "",
  ].join("\n");

const run = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const remoteTagExists = (tag) =>
  run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";

/** An unknown package fails with E404; an unknown version of a known package prints nothing. */
const publishedOnNpm = (name, version) => {
  try {
    return run("npm", ["view", `${name}@${version}`, "version"]) !== "";
  } catch (error) {
    if (String(error.stderr).includes("E404")) return false;
    throw error;
  }
};

/** Draft releases are visible only to tokens that can write repository contents. */
const draftReleaseExists = (tag) => {
  try {
    return (
      JSON.parse(run("gh", ["release", "view", tag, "--json", "isDraft"]))
        .isDraft === true
    );
  } catch {
    return false;
  }
};

const main = () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("typescript/package.json", root), "utf8"),
  );
  const tag = releaseTag(manifest.name, manifest.version);
  const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");
  const tagExists = remoteTagExists(tag);
  const pending =
    !tagExists && changelogSection(changelog, manifest.version) !== null;
  const plan = planRelease({
    name: manifest.name,
    version: manifest.version,
    changelog,
    tagExists,
    published: pending && publishedOnNpm(manifest.name, manifest.version),
    draftExists: pending && draftReleaseExists(tag),
  });
  const summary = describePlan(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `action=${plan.action}`,
        `name=${plan.name}`,
        `version=${plan.version}`,
        `tag=${plan.tag}`,
        `dist_tag=${plan.distTag}`,
        `prerelease=${plan.prerelease}`,
        "",
      ].join("\n"),
    );
  if (plan.notes && process.env.RELEASE_NOTES_FILE)
    writeFileSync(
      process.env.RELEASE_NOTES_FILE,
      releaseNotes(plan, manifest, process.env.GITHUB_SHA ?? "unknown"),
    );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
