# Changelog

All notable changes to `planpost-mcp`. Versions follow [semver](https://semver.org).

## 0.4.1 — 2026-11-14

### Changed
- Agents that sign in with OAuth see 34 tools: the scheduling, delivery,
  analytics, revenue and approval tools. The video, carousel, brand kit,
  content source and repurposing tools are left out for them, because those
  features are parked in the PlanPost app; an API key still gets all 49.
- `create_post` no longer points agents at the carousel tools; several
  attached images publish as a carousel where the network supports one.
- Descriptions in the README, `server.json`, the plugin manifests, GEMINI.md
  and the skill describe the product as it is now: an agentic scheduler, with
  approval as a choice the user makes (off by default).
- `generate_image` is among the tools left out for OAuth sign-ins: it calls a
  generative image model, which the Claude directory does not allow in a
  listed server.
- `.claude-plugin/marketplace.json` has a marketplace description.

### Removed
- The `send-to-plan-post` skill. It described one account's own groups, not
  the product. `skills/planpost` is the skill to install.

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
