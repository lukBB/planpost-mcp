# Changelog

All notable changes to `planpost-mcp`. Versions follow [semver](https://semver.org).

## 0.4.0 — 2026-11-09

### Added
- **OAuth sign-in for the hosted server.** With `--http`, the server is now an
  OAuth 2.1 resource server per the MCP authorization spec (revision
  2026-07-28): protected-resource metadata at
  `/.well-known/oauth-protected-resource`, a `401` +
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge for
  unauthenticated requests, access-token validation by introspection with an
  audience check, and no token passthrough. Clients that support remote MCP
  authorization (Claude, ChatGPT, Cursor, Gemini CLI, VS Code) can connect to
  `https://mcp.planpo.st/mcp` with no key. Enabled by
  `PLANPOST_MCP_PUBLIC_URL` + `PLANPOST_MCP_SERVICE_SECRET`; without them the
  server behaves exactly as before.
- **Tool annotations** on all 49 tools: `title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`.
- **Agent bundles** in the repository: `skills/planpost/SKILL.md`
  (`npx skills add`), `gemini-extension.json` + `GEMINI.md` (Gemini CLI
  extension), `.claude-plugin/` (Claude Code plugin and marketplace) and
  `.cursor-plugin/` + `mcp.json` (Cursor plugin).
- Tests for hosted OAuth mode and for manifest consistency; `npm test` now
  builds first.

### Changed
- `server.json`: the hosted remote's `Authorization` header is optional
  (omit it to sign in with OAuth).
- API-key authentication (`Authorization: Bearer pk_…` over HTTP,
  `PLANPOST_API_KEY` over stdio) is unchanged.

## 0.3.0 — 2026-11-08

- Listed on the official MCP Registry as `io.github.lukBB/planpost`
  (`server.json`, `mcpName`).
- Hosted-first README: install snippets for Claude Code, Claude Desktop,
  Cursor, Codex CLI and Gemini CLI.
- `retry_failed` and `get_delivery_report` tools; publish failures carry an
  error class and a suggested fix.
- `npm test`: registry schema validation and a stdio boot test.

## 0.2.x

- Streamable HTTP mode (`--http`) with per-request API keys, powering
  `https://mcp.planpo.st/mcp`.
- Account groups, approvals, smart scheduling, carousels, video rendering,
  content sources, brand voice, revenue overview.
