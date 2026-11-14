# planpost-mcp

MCP (Model Context Protocol) server for [PlanPost](https://planpo.st), the agentic social scheduler your AI agent can run. It lets Claude, ChatGPT, Cursor, Gemini CLI and other AI agents draft, schedule and publish posts to Instagram, Facebook, LinkedIn, X, Threads, TikTok and YouTube, see what failed and why, and read analytics and revenue from your PlanPost account.

## Quick start

### The short way: sign in

Add `https://mcp.planpo.st/mcp` to your agent as a remote MCP server (a
"connector" in Claude and ChatGPT) and leave the authentication fields empty.
The first time the agent uses it, a browser opens on planpo.st: log in, review
what the agent may do, and choose whether its posts wait for your approval
(they go out at the time the agent sets unless you turn that on). No key to
create or paste.

```bash
claude mcp add --transport http planpost https://mcp.planpo.st/mcp
```

```json
{ "mcpServers": { "planpost": { "url": "https://mcp.planpo.st/mcp" } } }
```

Connected agents are listed on the **Agent** page under **Connected apps**,
where you can turn approval on or off for each one, or remove it, at any time. They use the same permissions and the
same monthly call allowance as API keys.

The repository also ships ready-made bundles: a Claude Code plugin
(`.claude-plugin/`), a Cursor plugin (`.cursor-plugin/`), a Gemini CLI
extension (`gemini-extension.json`) and an agent skill:

```bash
npx skills add lukBB/planpost-mcp --skill planpost
gemini extensions install https://github.com/lukBB/planpost-mcp
claude plugin marketplace add lukBB/planpost-mcp && claude plugin install planpost@planpost-plugins
```

The rest of this section is the API-key route: use it for clients without
OAuth support, for CI, or when you want a key limited to a few permissions.

### 1. Get an API key

In the PlanPost dashboard open the **Agent** page and choose **Create key** and select the permissions you need (see the table below). The key (`pk_live_…`) is shown **once** — copy it.

> API/MCP access is included on every plan: Free 200 calls a month, Creator 1,000, Pro 10,000. Keys are scoped: a key with only `posts:read` cannot publish.

### 2. Add the server to your agent

Two ways to connect. **Hosted** is the default: point your client at
`https://mcp.planpo.st/mcp`, nothing to install, your key travels as a header.
**Local** runs the same server on your machine with `npx`, so the key never
leaves it. Both expose the same 49 tools to an API key; an agent that signs in
with OAuth gets 34 of them (see the note under Tools).

Replace `pk_live_xxx` with your key throughout.

**Claude Code**

```bash
claude mcp add --transport http planpost https://mcp.planpo.st/mcp \
  --header "Authorization: Bearer pk_live_xxx"
```

Local fallback:

```bash
claude mcp add planpost -e PLANPOST_API_KEY=pk_live_xxx -- npx -y planpost-mcp
```

Run `claude mcp list` afterwards to confirm it is connected.

**Claude Desktop**

Hosted: Settings → Connectors → Add custom connector. Name `PlanPost`, URL
`https://mcp.planpo.st/mcp`, then add the header `Authorization: Bearer pk_live_xxx`.

Local fallback, in `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then
restart the app:

```json
{
  "mcpServers": {
    "planpost": {
      "command": "npx",
      "args": ["-y", "planpost-mcp"],
      "env": { "PLANPOST_API_KEY": "pk_live_xxx" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`, or `.cursor/mcp.json` per project)

```json
{
  "mcpServers": {
    "planpost": {
      "url": "https://mcp.planpo.st/mcp",
      "headers": { "Authorization": "Bearer pk_live_xxx" }
    }
  }
}
```

Local fallback: replace the entry with
`{ "command": "npx", "args": ["-y", "planpost-mcp"], "env": { "PLANPOST_API_KEY": "pk_live_xxx" } }`.
A project-level `.cursor/mcp.json` is committed with your repo, so prefer the
hosted form and keep the key out of the file.

**OpenAI Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.planpost]
url = "https://mcp.planpo.st/mcp"
bearer_token_env_var = "PLANPOST_API_KEY"
```

Export `PLANPOST_API_KEY` in your shell; Codex reads the token from the
environment, not the file. `codex mcp add` does the same thing interactively.

Local fallback:

```toml
[mcp_servers.planpost]
command = "npx"
args = ["-y", "planpost-mcp"]

[mcp_servers.planpost.env]
PLANPOST_API_KEY = "pk_live_xxx"
```

**Gemini CLI** (`~/.gemini/settings.json`, or `.gemini/settings.json` per project)

```json
{
  "mcpServers": {
    "planpost": {
      "httpUrl": "https://mcp.planpo.st/mcp",
      "headers": { "Authorization": "Bearer pk_live_xxx" },
      "timeout": 10000
    }
  }
}
```

Gemini CLI uses `httpUrl` for streamable HTTP, not `url`; the wrong key is a
silent no-op. Local fallback: the same `command`/`args`/`env` entry as Cursor.

**Any other MCP client:** connect to `https://mcp.planpo.st/mcp` (streamable
HTTP, `Authorization: Bearer pk_live_xxx` on every request), or run
`npx -y planpost-mcp` over stdio with `PLANPOST_API_KEY` set. Per-client
walkthroughs with screenshots: [planpo.st/docs/agents](https://planpo.st/docs/agents).

### Self-hosting the HTTP endpoint

`mcp.planpo.st` is this same package running with `--http`. To run your own:

```bash
npx -y planpost-mcp --http --port 3020     # exposes POST /mcp (+ /health)
```

Behind a reverse proxy, bind to loopback so the port isn't reachable directly:

```bash
HOST=127.0.0.1 npx -y planpost-mcp --http --port 3020
```

The transport is stateless (streamable HTTP); credentials are read from every
request and scoped to it, so one hosted instance serves many users safely. Put
it behind HTTPS in production. `--host` / `HOST` default to `0.0.0.0`, so
containers and LAN use work without extra flags.

A self-hosted endpoint accepts API keys (`Authorization: Bearer pk_...`) out of
the box. OAuth sign-in is switched on by three variables, and needs a PlanPost
API that runs the authorization server (`/oauth/*`):

| Variable | Description |
|---|---|
| `PLANPOST_MCP_PUBLIC_URL` | Public URL of this endpoint, e.g. `https://mcp.example.com/mcp`. Tokens are issued for exactly this URL. |
| `PLANPOST_MCP_SERVICE_SECRET` | 32+ random characters shared with the API (`MCP_SERVICE_SECRET` there). |
| `PLANPOST_OAUTH_ISSUER` | Authorization server origin. Defaults to `PLANPOST_API_URL`. |
| `OPENAI_APPS_CHALLENGE` | Optional. Token served at `/.well-known/openai-apps-challenge` for ChatGPT directory domain verification. |

With those set the server follows the MCP authorization spec: it serves
`/.well-known/oauth-protected-resource`, answers unauthenticated requests with
`401` and a `WWW-Authenticate: Bearer resource_metadata="…"` challenge,
validates access tokens by introspection, checks they were issued for this
endpoint, and never forwards them upstream.

### 3. Talk to it

> "Schedule this post to my Polish Pages group for tomorrow 9:00: …"
>
> "Here is my new blog post. Write one version per network and spread them across next week."
>
> "What failed to publish this week, and what do I need to fix?"
>
> "How much revenue did my posts drive last 30 days?"

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PLANPOST_API_KEY` | stdio only | API key from the Agent page in PlanPost (`pk_live_…`). Not needed with `--http`, where each request brings its own credentials. |
| `PLANPOST_API_URL` | — | API base URL (default `https://api.planpo.st`) |

## Tools

49 tools, grouped below. An agent that signs in with OAuth (the hosted server with no key, which is how Claude, ChatGPT and Cursor connect) is offered 34: the AI image tool and the video, carousel, brand kit, content source and repurposing tools are left out, because those features are parked in the PlanPost app. An API key gets all 49. The permission column is the scope a tool needs, whether it comes from an API key or from OAuth sign-in; a credential without the scope gets a clear error rather than a silent failure. Every tool carries MCP annotations (a title plus read-only, destructive and open-world hints) so clients know which calls to confirm.

### Posts & publishing

| Tool | Required permission | Description |
|---|---|---|
| `list_posts` | `posts:read` | List posts, filter by status/platform |
| `get_post` | `posts:read` | Fetch one post |
| `create_post` | `posts:write` | Create a draft or scheduled post (per-platform content/settings/media, UTM overrides, timezone) |
| `update_post` | `posts:write` | Update a draft/scheduled post |
| `delete_post` | `posts:write` | Delete a post |
| `publish_post` | `posts:write` | Publish immediately |
| `retry_failed` | `posts:write` | Re-queue the platforms that failed for a transient reason; never re-posts one that went out |
| `get_delivery_report` | `posts:read` | The morning check: recent failed or partly failed posts with each platform's error and fix, unhealthy connections, approvals running late |
| `preview_post` | `posts:read` | Show exactly what each platform will receive (text after overrides, attachments, warnings) |
| `bulk_create_posts` | `posts:write` | Create a whole campaign of posts from one manifest |
| `list_campaigns` | `posts:read` | Campaign tags in use, with post counts by status and platform |
| `delete_posts` | `posts:write` | Bulk-delete posts matching a filter (a filter is required) |
| `list_media` | `media:read` | Media already uploaded, so an asset can be reused instead of re-uploaded |
| `upload_media` | `media:write` | Get a presigned URL to upload an image/video |
| `repurpose_content` | `repurpose:write` | Save repurposed content as draft posts |

### Accounts

| Tool | Required permission | Description |
|---|---|---|
| `list_connections` | `connections:read` | Connected social accounts |
| `list_account_groups` | `groups:read` | Named account groups (e.g. "Polish Pages") |
| `get_account_group` | `groups:read` | Resolve a group by id/name/default → connection IDs |
| `create_account_group` | `groups:write` | Create a named group bundling connections |
| `update_account_group` | `groups:write` | Rename, recolour, set default, or replace a group's connections |
| `delete_account_group` | `groups:write` | Delete a group (the accounts stay connected) |
| `add_connections_to_group` | `groups:write` | Add connections to a group |
| `remove_connections_from_group` | `groups:write` | Remove connections from a group |
| `get_connection_link` | `connections:read` | Link the user opens in a browser to connect a new social account (OAuth needs a human) |

Connecting a new social account requires OAuth in a browser: `get_connection_link` hands the user the link, and the agent can target the account once it is connected.

X needs a paid plan. On the free plan `get_connection_link` answers with an upgrade message for `twitter`, `list_connections` marks an X account that is already connected as not on the current plan, and a post that targets X is saved as a draft with the `x_requires_paid_plan` error.

### Approvals

| Tool | Required permission | Description |
|---|---|---|
| `submit_for_approval` | `approvals:write` | Send a post to a human reviewer (required when the API key is approval-gated) |
| `list_pending_approvals` | `approvals:read` | Posts waiting for review, with outcomes |
| `get_approval_status` | `approvals:read` | Pending / approved / rejected / changes requested for one submission |

### Scheduling

| Tool | Required permission | Description |
|---|---|---|
| `get_best_times` | `schedule:read` | Best posting times per platform from the account's engagement history |
| `suggest_schedule` | `schedule:read` | Spread N posts across a date range at optimal times; returns concrete timestamps |
| `get_posting_schedule` | `schedule:read` | Weekly queue slots, global plus per-group overrides |
| `set_posting_schedule` | `schedule:write` | Replace the weekly queue slots for the global schedule or one group (Pro) |

### Video & carousels

| Tool | Required permission | Description |
|---|---|---|
| `list_video_templates` | `videos:read` | Browse video templates and their editable fields |
| `create_video` | `videos:write` | Submit a render job from a template |
| `get_video_status` | `videos:read` | Poll a render; completed renders return download URLs |
| `generate_carousel` | `carousels:write` | Decompose long-form content into carousel slide text |
| `list_carousel_styles` | `carousels:read` | Template families, 40-palette library, formats, font pairings |
| `render_carousel` | `carousels:write` | Render slides into branded PNGs in the media library |
| `get_carousel_render` | `carousels:read` | Poll a render; completed renders return post-ready media assets |
| `list_brand_kits` | `brand-kits:read` | Saved brand kits (palette, fonts, logo, handle) for `render_carousel` |
| `generate_image` | `images:write` | Generate an image with AI for a post (1 AI credit); pass the URL to `create_post` |

### Content sources

| Tool | Required permission | Description |
|---|---|---|
| `list_content_sources` | `content-sources:read` | List WordPress/RSS sources |
| `add_content_source` | `content-sources:write` | Connect a WordPress site or RSS feed |
| `delete_content_source` | `content-sources:write` | Remove a source |
| `fetch_source_content` | `content-sources:write` | Import the latest content now |
| `list_imported_content` | `content-sources:read` | List imported content for repurposing |

### Analytics & revenue

| Tool | Required permission | Description |
|---|---|---|
| `get_analytics` | `analytics:read` | Post performance (impressions, likes, comments, shares) |
| `get_revenue_overview` | `revenue:read` | Revenue totals + trend; optionally recent transactions and Stripe/RevenueCat MRR |

Revenue data is read-only over the API; connecting Stripe/RevenueCat/Shopify happens in the dashboard (Settings → Revenue).

### Brand voice (Pro)

| Tool | Required permission | Description |
|---|---|---|
| `get_brand_voices` | `brand-voice:read` | Tone-of-voice profiles analysed from the user's content |
| `get_brand_voice_prompt` | `brand-voice:read` | Ready-to-use system prompt for a voice; apply it when drafting posts |

## A typical agent workflow

1. `get_account_group` (`default: true`) → connection IDs
2. `list_video_templates` → pick a template → `create_video` → poll `get_video_status`
3. `upload_media` (or use the render URL) → `create_post` with `scheduledFor`
4. Later: `get_analytics` and `get_revenue_overview` to report results

Or, for a branded carousel post end-to-end:

1. `generate_carousel` (long-form content → slide text)
2. `list_carousel_styles` / `list_brand_kits` → pick a family + palette or kit
3. `render_carousel` → poll `get_carousel_render` → completed `assets`
4. `create_post` with those assets as `media` (they're already attachment-shaped)

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # builds, validates server.json and the plugin manifests, boots stdio, exercises hosted OAuth mode
PLANPOST_API_KEY=pk_test_xxx node dist/index.js
```

The server speaks MCP over stdio, or streamable HTTP with `--http`. It calls the PlanPost public API (`/api/public/v1`) with your credentials; nothing else is stored or sent anywhere. Changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## Maintainers

Releasing a version means publishing twice: the code to npm, then the metadata
to the [official MCP Registry](https://registry.modelcontextprotocol.io), which
only stores `server.json` and checks that the npm package it points at exists
and carries the matching `mcpName`. Glama and other directories import from the
registry, so the second step is what makes a release discoverable.

1. Bump `version` in `package.json` **and** in `server.json` (top level and
   `packages[0].version`), `gemini-extension.json`, `.claude-plugin/plugin.json`
   and `.cursor-plugin/plugin.json`, and add a `CHANGELOG.md` entry. `npm test`
   fails if any of them disagree.
2. Publish to npm first; the registry rejects a version npm does not have yet:

   ```bash
   npm publish --access public
   ```

3. Install the publisher CLI once (`brew install mcp-publisher`, or the tarball
   from the registry's GitHub releases), then log in. The `io.github.lukBB/*`
   namespace is proven by GitHub device-flow login as that account:

   ```bash
   mcp-publisher login github
   ```

4. Validate and publish from this directory:

   ```bash
   mcp-publisher validate
   mcp-publisher publish
   ```

5. Confirm the listing:

   ```bash
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.lukBB/planpost"
   ```

An expired token shows as "Invalid or expired Registry JWT token": run the login
again. `mcp-publisher status` deprecates or deletes a published version.
A tagged GitHub release is what the Gemini CLI extension gallery and the
plugin marketplaces pick up, so tag `vX.Y.Z` after publishing.

## License

MIT
