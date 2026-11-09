// server.json is what the official MCP Registry publishes; package.json is what
// npm publishes. The registry rejects a publish when the two disagree, so the
// cheap check lives here instead of in a failed `mcp-publisher publish`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const pkg = read("../package.json");
const serverJson = read("../server.json");

async function loadSchema() {
  const vendored = read("./fixtures/server.schema.2025-12-11.json");
  if (process.env.OFFLINE) return vendored;
  try {
    const res = await fetch(serverJson.$schema, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return await res.json();
  } catch {
    /* fall through to the vendored copy */
  }
  return vendored;
}

test("server.json validates against the MCP registry schema", async () => {
  const schema = await loadSchema();
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(serverJson);
  assert.ok(ok, JSON.stringify(validate.errors, null, 2));
});

test("server.json and package.json agree", () => {
  assert.equal(serverJson.name, pkg.mcpName, "mcpName must equal server.json name");
  assert.equal(serverJson.version, pkg.version, "versions must match");
  const npm = serverJson.packages.find((p) => p.registryType === "npm");
  assert.ok(npm, "an npm package entry is required");
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.ok(serverJson.description.length <= 100, "registry caps description at 100 chars");
  assert.ok(serverJson.remotes.some((r) => r.url === "https://mcp.planpo.st/mcp"));
});
