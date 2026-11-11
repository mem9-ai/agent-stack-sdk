// Decides whether the TypeScript package on this commit should be published.
// A version is released when CHANGELOG.md has its own section and the version
// has no release tag yet. See RELEASING.md.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export const releaseTag = (version) => `typescript-v${version}`;

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

export const planRelease = ({ name, version, changelog, tagExists }) => {
  if (!SEMVER.test(version))
    throw new Error(`Package version "${version}" is not a SemVer version`);
  const base = { name, version, tag: releaseTag(version) };
  if (tagExists)
    return { ...base, release: false, reason: `${base.tag} already exists` };
  const notes = changelogSection(changelog, version);
  if (notes === null)
    return {
      ...base,
      release: false,
      reason: `CHANGELOG.md has no "## ${version}" section, so ${version} is still in development`,
    };
  if (!notes)
    throw new Error(`CHANGELOG.md section "## ${version}" is empty`);
  const prerelease = version.includes("-");
  return {
    ...base,
    release: true,
    prerelease,
    distTag: prerelease ? "next" : "latest",
    notes,
  };
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

const remoteTagExists = (tag) =>
  execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
    encoding: "utf8",
  }).trim() !== "";

const main = () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("typescript/package.json", root), "utf8"),
  );
  const plan = planRelease({
    name: manifest.name,
    version: manifest.version,
    changelog: readFileSync(new URL("CHANGELOG.md", root), "utf8"),
    tagExists: remoteTagExists(releaseTag(manifest.version)),
  });
  const summary = plan.release
    ? `Release: publish \`${plan.name}@${plan.version}\` to npm dist-tag \`${plan.distTag}\` and create \`${plan.tag}\`.`
    : `No release: ${plan.reason}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `release=${plan.release}`,
        `name=${plan.name}`,
        `version=${plan.version}`,
        `tag=${plan.tag}`,
        `dist_tag=${plan.distTag ?? ""}`,
        `prerelease=${plan.prerelease ?? false}`,
        "",
      ].join("\n"),
    );
  if (plan.release && process.env.RELEASE_NOTES_FILE)
    writeFileSync(
      process.env.RELEASE_NOTES_FILE,
      releaseNotes(plan, manifest, process.env.GITHUB_SHA ?? "unknown"),
    );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
