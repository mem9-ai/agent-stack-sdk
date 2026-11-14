#!/usr/bin/env node
// Regenerates the frozen service-contract snapshots from a TiDB Link service
// checkout. Usage:
//
//   AGENT_SERVICE_ROOT=/path/to/agent-stack node scripts/refresh-contract.mjs
//
// The checkout must be clean and at the revision to pin. The script writes
// each selected OpenAPI subset, the Backend Connection protocol schema, `metadata.json`, and the baseline in
// `package.json`, `src/index.ts` and the README links. Review the diff and the contract tests
// before committing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.env.AGENT_SERVICE_ROOT;
if (!root) throw new Error("Set AGENT_SERVICE_ROOT to a service checkout");
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
if (
  git(
    "status",
    "--porcelain",
    "--",
    "docs/openapi.yaml",
    "docs/backend-connection-v1.schema.json",
  )
)
  throw new Error("The selected service contracts have local changes");
const revision = git("rev-parse", "HEAD");

const { parse } = createRequire(join(root, "package.json"))("yaml");
const source = await readFile(join(root, "docs/openapi.yaml"));
const sourceSha256 = sha256(source);
const document = parse(source.toString("utf8"));

const user = "/api/v1/org/users/{userId}";
const session = `${user}/sessions/{id}`;

/** Each snapshot freezes the routes one part of the SDK calls. */
const snapshots = {
  "openapi.json": {
    full: true,
    paths: [
      "/api/v1/org",
      "/api/v1/org/users",
      "/api/v1/org/users/{userId}",
      `${user}/agent-templates`,
      `${user}/agent-models`,
      `${user}/realtime-models`,
      `${user}/sessions`,
      session,
      `${session}/model`,
      `${session}/realtime-model`,
      `${session}/billing-tag`,
      `${session}/template-switches`,
      `${session}/name`,
      `${session}/name/suggest`,
      `${session}/events`,
      `${session}/interactions`,
      `${session}/interactions/{receiptId}`,
      `${session}/turns`,
      `${session}/turns/{turnId}`,
      `${session}/timeline`,
      `${session}/tools`,
      `${session}/realtime`,
      `${session}/realtime/connect-tokens`,
      `${user}/billing/usage`,
      `${user}/billing/usage/details`,
    ],
  },
  "files.json": {
    paths: [
      `${user}/files`,
      `${user}/files/{fileId}`,
      `${user}/files/{fileId}/content`,
      `${user}/drive/upload-capabilities`,
      `${user}/drive/uploads`,
      `${user}/drive/uploads/{uploadId}`,
      `${user}/drive/uploads/{uploadId}/content`,
      `${user}/drive/uploads/{uploadId}/parts/{partNumber}/presign`,
      `${user}/drive/uploads/{uploadId}/complete`,
      "/api/v1/drive-uploads/{ticket}",
      "/api/v1/drive-downloads/{ticket}",
    ],
  },
  "management.json": {
    paths: [
      "/api/v1/org/agent-templates",
      "/api/v1/org/agent-templates/{templateId}",
      "/api/v1/org/agent-templates/{templateId}/archive",
      "/api/v1/org/agent-template-reference-catalog",
      "/api/v1/org/skills",
      "/api/v1/org/skills/{skillId}",
      "/api/v1/org/skills/uploads",
      "/api/v1/org/skills/uploads/{uploadId}",
      "/api/v1/org/skills/uploads/{uploadId}/publish",
    ],
  },
  "connectors.json": {
    paths: [
      "/api/v1/org/connectors",
      "/api/v1/org/connectors/{connectorId}",
      "/api/v1/org/connectors/{connectorId}/activate",
      "/api/v1/org/connectors/{connectorId}/deactivate",
      "/api/v1/connectors/jwks",
    ],
  },
  "audio.json": {
    paths: [`${session}/turns/audio`],
    schemas: ["TurnStreamEvent"],
  },
};

for (const [name, selection] of Object.entries(snapshots)) {
  const paths = {};
  for (const path of selection.paths) {
    const item = document.paths[path];
    if (!item) throw new Error(`${name}: service has no route ${path}`);
    paths[path] = item;
  }
  const components = collectComponents(paths, selection.schemas ?? []);
  const snapshot = selection.full
    ? {
        openapi: document.openapi,
        info: document.info,
        paths,
        components,
      }
    : { revision, sourceOpenApiSha256: sourceSha256, paths, components };
  await write(name, snapshot);
}

// The Backend Connection protocol is published beside the OpenAPI as JSON Schema.
const backendSchema = JSON.parse(
  await readFile(join(root, "docs/backend-connection-v1.schema.json"), "utf8"),
);
await write("backend-connection.json", {
  revision,
  sourceSchemaSha256: sha256(
    await readFile(join(root, "docs/backend-connection-v1.schema.json")),
  ),
  schema: backendSchema,
});

const metadataPath = new URL("../service-contract/metadata.json", import.meta.url);
const metadata = {
  tidbLinkRevision: revision,
  tidbLinkApiVersion: document.info.version,
  sourceOpenApiSha256: sourceSha256,
  snapshots: {},
};
for (const name of [...Object.keys(snapshots), "backend-connection.json"])
  metadata.snapshots[name] = sha256(
    await readFile(new URL(`../service-contract/${name}`, import.meta.url)),
  );
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

const manifestPath = new URL("../package.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.tidbLinkApiVersion = document.info.version;
manifest.tidbLinkRevision = revision;
manifest.tidbLinkOpenApiSha256 = sourceSha256;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const indexPath = new URL("../src/index.ts", import.meta.url);
const index = (await readFile(indexPath, "utf8"))
  .replace(
    /TIDB_LINK_API_VERSION = "[^"]*"/,
    `TIDB_LINK_API_VERSION = "${document.info.version}"`,
  )
  .replace(/TIDB_LINK_REVISION =\s*"[0-9a-f]{40}"/, `TIDB_LINK_REVISION =\n  "${revision}"`);
await writeFile(indexPath, index);

const readmePath = new URL("../README.md", import.meta.url);
const readme = (await readFile(readmePath, "utf8"))
  .replace(
    /(agent-stack\/(?:commit|blob)\/)[0-9a-f]{40}/g,
    `$1${revision}`,
  )
  .replace(/(service revision\s+)[0-9a-f]{8}\]/, `$1${revision.slice(0, 8)}]`);
await writeFile(readmePath, readme);

console.log(`Pinned service ${revision}`);
console.log(`OpenAPI SHA-256 ${sourceSha256}`);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function write(name, value) {
  await writeFile(
    new URL(`../service-contract/${name}`, import.meta.url),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

/** Copy every component the selected routes reach, plus any named schemas. */
function collectComponents(paths, schemas) {
  const selected = {};
  const pending = schemas.map((schema) => `#/components/schemas/${schema}`);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") pending.push(child);
      else visit(child);
    }
  };
  visit(paths);
  for (const item of Object.values(paths))
    for (const operation of Object.values(item))
      for (const requirement of operation?.security ?? [])
        for (const scheme of Object.keys(requirement))
          pending.push(`#/components/securitySchemes/${scheme}`);
  while (pending.length) {
    const ref = pending.pop();
    const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
    if (!match) throw new Error(`Unsupported reference ${ref}`);
    const [, group, name] = match;
    if (selected[group]?.[name]) continue;
    const component = document.components?.[group]?.[name];
    if (!component) throw new Error(`Missing component ${ref}`);
    (selected[group] ??= {})[name] = component;
    visit(component);
  }
  const sorted = {};
  for (const group of Object.keys(selected).sort()) {
    sorted[group] = {};
    for (const name of Object.keys(selected[group]).sort())
      sorted[group][name] = selected[group][name];
  }
  return sorted;
}
