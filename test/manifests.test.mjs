// The marketplace bundles (Claude plugin, Cursor plugin, Gemini extension,
// skills) are plain files nobody runs locally, so a typo ships silently.
// This keeps them parseable, pointing at the same endpoint, and on the same
// version as package.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const text = (p) => readFileSync(new URL(p, root), "utf8");
const json = (p) => JSON.parse(text(p));
const pkg = json("package.json");
const ENDPOINT = "https://mcp.planpo.st/mcp";
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test("every manifest carries the package version", () => {
  for (const file of ["gemini-extension.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    assert.equal(json(file).version, pkg.version, `${file} version`);
  }
  assert.match(text("CHANGELOG.md"), new RegExp(`^## ${pkg.version.replaceAll(".", "\\.")}\\b`, "m"));
});

test("every bundle points at the hosted endpoint, with no credentials baked in", () => {
  const gemini = json("gemini-extension.json");
  assert.match(gemini.name, KEBAB);
  // Gemini CLI: `httpUrl` is streamable HTTP; `url` would mean SSE.
  assert.deepEqual(gemini.mcpServers.planpost, { httpUrl: ENDPOINT });
  assert.ok(existsSync(new URL(gemini.contextFileName, root)));

  assert.deepEqual(json(".mcp.json").mcpServers.planpost, { type: "http", url: ENDPOINT });
  assert.deepEqual(json("mcp.json").mcpServers.planpost, { url: ENDPOINT });

  const remote = json("server.json").remotes.find((r) => r.url === ENDPOINT);
  assert.ok(remote, "server.json lists the hosted remote");
  assert.ok(remote.headers.every((h) => h.isRequired === false), "OAuth clients send no header");
});

test("Claude and Cursor plugin manifests are well-formed", () => {
  const claude = json(".claude-plugin/plugin.json");
  assert.match(claude.name, KEBAB);
  assert.doesNotMatch(claude.name, /^(claude-|anthropic-|cc-plugin-)/);
  assert.ok(existsSync(new URL(claude.icon, root)), "icon file exists");
  for (const key of ["privacyPolicyUrl", "termsOfServiceUrl", "supportUrl", "documentationUrl"]) {
    assert.match(claude[key], /^https:\/\//, key);
  }

  const market = json(".claude-plugin/marketplace.json");
  assert.ok(market.name && market.owner?.name);
  assert.ok(market.plugins.some((p) => p.name === claude.name && p.source === "./"));

  const cursor = json(".cursor-plugin/plugin.json");
  assert.match(cursor.name, KEBAB);
  assert.ok(existsSync(new URL(cursor.logo, root)), "logo file exists");
});

test("each skill has the frontmatter `npx skills add` and the plugin loaders require", () => {
  const dirs = readdirSync(new URL("skills/", root), { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.ok(dirs.some((d) => d.name === "planpost"));
  for (const dir of dirs) {
    const body = text(`skills/${dir.name}/SKILL.md`);
    const front = body.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, `${dir.name}: frontmatter block`);
    const name = front[1].match(/^name:\s*(.+)$/m)?.[1].trim();
    const description = front[1].match(/^description:\s*(.+)$/m)?.[1].trim();
    assert.equal(name, dir.name, `${dir.name}: name matches its folder`);
    assert.match(name, KEBAB);
    assert.ok(description && description.length <= 1024, `${dir.name}: description present, at most 1024 chars`);
  }
});

test("the package stands alone: no imports reach outside it", () => {
  for (const file of readdirSync(new URL("src/", root))) {
    const source = text(`src/${file}`);
    for (const [, spec] of source.matchAll(/from\s+"([^"]+)"/g)) {
      const ok =
        spec.startsWith("node:") ||
        spec.startsWith("./") ||
        spec === "zod" ||
        spec.startsWith("@modelcontextprotocol/sdk/");
      assert.ok(ok, `src/${file} imports "${spec}"`);
    }
  }
  assert.ok(existsSync(new URL("LICENSE", root)));
  assert.ok(text("README.md").split(/\s+/).length > 40);
});
