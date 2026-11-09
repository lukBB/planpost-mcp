// Boots the built server over stdio exactly the way `npx -y planpost-mcp`
// does, and lists its tools. No network: tool listing needs no API call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("stdio server starts and exposes its tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, PLANPOST_API_KEY: "pk_test_offline" },
    stderr: "pipe",
  });
  const client = new Client({ name: "planpost-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const info = client.getServerVersion();
    assert.equal(info?.name, "planpost");
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 40, `expected the full tool set, got ${tools.length}`);
    for (const t of tools) assert.ok(t.description, `${t.name} has no description`);
    // The Claude and ChatGPT directories reject tools without a title and
    // explicit read-only / destructive / open-world hints.
    for (const t of tools) {
      assert.ok(t.annotations?.title, `${t.name} has no title annotation`);
      for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
        assert.equal(typeof t.annotations[hint], "boolean", `${t.name} is missing ${hint}`);
      }
      assert.ok(t.name.length <= 64, `${t.name} is longer than 64 characters`);
    }
    const hints = (name) => tools.find((t) => t.name === name).annotations;
    assert.equal(hints("list_connections").readOnlyHint, true);
    assert.equal(hints("publish_post").destructiveHint, true);
    assert.equal(hints("delete_post").readOnlyHint, false);
    for (const name of ["create_post", "list_connections", "get_analytics", "render_carousel"]) {
      assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
    }
  } finally {
    await client.close();
  }
});
