// Hosted (streamable HTTP) mode with OAuth switched on, against a stub of the
// PlanPost API. Covers what an MCP client needs to start and finish the flow:
// the 401 challenge, the protected-resource metadata it points at, token
// validation (active, audience), and that tool calls reach the API with the
// server's own credentials rather than the user's access token.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const SECRET = "test-service-secret-0123456789abcdef";
const GRANT_ID = "64b0000000000000000000aa";

/** token → introspection response. Anything else is inactive. */
const tokens = new Map();
/** Requests the stub API received on /api/public/v1/*. */
const apiCalls = [];
let introspectionDown = false;

let api, apiUrl, mcp, mcpUrl, keyOnly, keyOnlyUrl;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startMcp(env) {
  const port = String(await freePort());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "--http", "--port", port, "--host", "127.0.0.1"], {
      env: { ...process.env, PLANPOST_API_KEY: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = out.match(/listening on (http:\/\/[^\s/]+)\/mcp/);
      if (match) resolve({ child, url: match[1] });
    });
    child.stderr.on("data", () => {});
    child.on("exit", (code) => reject(new Error(`planpost-mcp exited early (${code}): ${out}`)));
  });
}

before(async () => {
  api = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/oauth/introspect") {
        if (introspectionDown) return json(500, { error: "server_error" });
        if (req.headers.authorization !== `Bearer ${SECRET}`) return json(401, { error: "invalid_client" });
        const token = new URLSearchParams(raw).get("token");
        return json(200, tokens.get(token) ?? { active: false });
      }
      if (req.url.startsWith("/api/public/v1/connections")) {
        apiCalls.push({ url: req.url, headers: req.headers });
        return json(200, { success: true, data: [{ id: "c1", provider: "linkedin" }] });
      }
      json(404, { message: "not found" });
    });
  });
  apiUrl = `http://127.0.0.1:${await listen(api)}`;

  ({ child: mcp, url: mcpUrl } = await startMcp({
    PLANPOST_API_URL: apiUrl,
    PLANPOST_MCP_PUBLIC_URL: "https://mcp.planpo.test/mcp",
    PLANPOST_OAUTH_ISSUER: "https://api.planpo.test",
    PLANPOST_MCP_SERVICE_SECRET: SECRET,
    OPENAI_APPS_CHALLENGE: "challenge-token-123",
  }));
  ({ child: keyOnly, url: keyOnlyUrl } = await startMcp({ PLANPOST_API_URL: apiUrl }));

  const exp = Math.floor(Date.now() / 1000) + 3600;
  tokens.set("ppo_at_good", {
    active: true,
    scope: "connections:read posts:read",
    client_id: "ppo_client_x",
    aud: "https://mcp.planpo.test/mcp",
    exp,
    grant_id: GRANT_ID,
  });
  tokens.set("ppo_at_other_audience", {
    active: true,
    scope: "connections:read",
    client_id: "ppo_client_x",
    aud: "https://someone-else.example/mcp",
    exp,
    grant_id: GRANT_ID,
  });
});

after(() => {
  mcp?.kill?.();
  keyOnly?.kill?.();
  api?.close();
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const post = (base, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(initialize),
  });

async function callListConnections(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "planpost-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "list_connections", arguments: {} });
  } finally {
    await client.close();
  }
}

test("an unauthenticated request gets 401 with the resource-metadata pointer", async () => {
  const res = await post(mcpUrl);
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate");
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    /resource_metadata="https:\/\/mcp\.planpo\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  // No error code when no token was sent (RFC 6750 §3.1).
  assert.doesNotMatch(challenge, /error=/);
});

test("the protected-resource metadata names the resource and its authorization server", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const res = await fetch(`${mcpUrl}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const meta = await res.json();
    assert.equal(meta.resource, "https://mcp.planpo.test/mcp");
    assert.deepEqual(meta.authorization_servers, ["https://api.planpo.test"]);
    assert.deepEqual(meta.bearer_methods_supported, ["header"]);
  }
  assert.equal((await fetch(`${mcpUrl}/.well-known/oauth-protected-resource/other`)).status, 404);
});

test("an invalid, expired or revoked token gets 401 invalid_token", async () => {
  const res = await post(mcpUrl, { Authorization: "Bearer ppo_at_revoked" });
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate");
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /resource_metadata="/);
});

test("a token issued for another resource is rejected (audience check)", async () => {
  const res = await post(mcpUrl, { Authorization: "Bearer ppo_at_other_audience" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("a valid token can call list_connections, and the token is not passed upstream", async () => {
  apiCalls.length = 0;
  const result = await callListConnections("ppo_at_good");
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.match(result.content[0].text, /linkedin/);

  assert.equal(apiCalls.length, 1);
  const { headers } = apiCalls[0];
  assert.equal(headers["x-planpost-oauth-grant"], GRANT_ID);
  assert.equal(headers["x-planpost-mcp-secret"], SECRET);
  assert.equal(headers.authorization, undefined);
  assert.ok(!JSON.stringify(headers).includes("ppo_at_good"));
});

test("API keys keep working unchanged when OAuth is on", async () => {
  apiCalls.length = 0;
  const result = await callListConnections("pk_live_abcdef0123456789");
  assert.ok(!result.isError);
  const { headers } = apiCalls[0];
  assert.equal(headers.authorization, "Bearer pk_live_abcdef0123456789");
  assert.equal(headers["x-planpost-oauth-grant"], undefined);
  assert.equal(headers["x-planpost-mcp-secret"], undefined);
});

test("an authorization-server outage is a 503, not a 401", async () => {
  introspectionDown = true;
  try {
    const res = await post(mcpUrl, { Authorization: "Bearer ppo_at_never_seen_before" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("www-authenticate"), null);
  } finally {
    introspectionDown = false;
  }
});

test("without OAuth configured the server stays key-only and sends no challenge", async () => {
  const res = await post(keyOnlyUrl);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.equal((await fetch(`${keyOnlyUrl}/.well-known/oauth-protected-resource/mcp`)).status, 404);
  const oauthToken = await post(keyOnlyUrl, { Authorization: "Bearer ppo_at_good" });
  assert.equal(oauthToken.status, 401);
});

test("the OpenAI domain-verification token is served only when configured", async () => {
  const res = await fetch(`${mcpUrl}/.well-known/openai-apps-challenge`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.equal(await res.text(), "challenge-token-123");
  assert.equal((await fetch(`${keyOnlyUrl}/.well-known/openai-apps-challenge`)).status, 404);
});
