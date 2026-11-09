---
name: send-to-plan-post
description: Compose and route social posts through the user's PlanPost app. Resolves named account groups ("Polish Pages", "English Pages", "SaaS", "Personal", etc.) into PlanPost connection IDs and creates draft, scheduled, or immediately-published posts. MANDATORY TRIGGERS - "send to plan post", "/send-to-plan-post", "post to PlanPost", "publish via PlanPost", "save as draft on PlanPost", "post to my <group> pages", "post this to my <group> group", "draft on PlanPost", "schedule on PlanPost", "post to Polish Pages", "post to English Pages". Also trigger when the user pastes social copy and references any known group name. Requires the planpost-mcp server registered with PLANPOST_API_KEY.
---

# send-to-plan-post

## What this skill does

Routes user-provided content to the right set of social accounts in PlanPost, using account groups as the primary targeting concept (with a fallback to individual handle targeting). Supports draft, scheduled, and immediate-publish modes. Handles image/video attachments via PlanPost's presigned S3 upload flow.

## Required MCP tools (`planpost-mcp`)

The user must have the `planpost-mcp` server installed and authenticated with `PLANPOST_API_KEY`. This skill calls:

- `list_account_groups` — resolve a group name into its connections
- `get_account_group` — fetch one group (by id, name, or default flag)
- `list_connections` — fallback when targeting individual accounts
- `upload_media` — presigned-URL upload for attached files
- `create_post` — draft or scheduled creation
- `publish_post` — immediate publish of a created post
- (read-only) `list_posts`, `get_post` — for "show me what I just sent"

The API key needs these permissions: `groups:read`, `connections:read`, `posts:read`, `posts:write`, `media:write`.

If the MCP server is missing or the API key is unset, stop and tell the user how to install/configure it (see `packages/mcp-server/README.md`). Do not fall back to web scraping or computer-use clicking through the dashboard.

## Flow

### Step 1 — Parse the request

From the user's message extract:

- **Content** — the post body. Preserve the user's language exactly (Polish stays Polish, English stays English). Do not "improve" copy unless asked.
- **Target** — one of: a group name ("Polish Pages"), a list of handles ("@triathlon_info_pl on IG"), or "default".
- **Mode** — `draft` | `schedule` | `publish-now`. **Default to `draft` when ambiguous.** Only schedule or publish if the user explicitly asks for it.
- **Schedule time** — if mode is `schedule`, an ISO datetime or natural phrase ("tomorrow 9am"). Resolve to ISO 8601 in the user's timezone before sending.
- **Media** — any files attached in the chat or URLs the user pasted.
- **Platform overrides** — per-platform variants (`platformContent`) or settings (`platformSettings`, e.g. `{ instagram: { isReel: true } }`) only if the user gave them explicitly.

### Step 2 — Resolve targets

- **Group by name** → call `list_account_groups`, do a case-insensitive exact-name match first; if no hit, try substring; if multiple match, ask the user to pick from the matches.
- **Default group** → call `get_account_group` with `{ default: true }`.
- **Specific handles** → call `list_connections`, filter by `provider` + `providerUsername` (lowercase compare, strip leading `@`).
- **No target resolved** → stop, list every group the user has, ask which one.

Capture the resolved `connectionIds[]` and the human-readable list (`provider @handle`) for the confirmation step.

### Step 3 — Handle media

For each attached file:

1. Call `upload_media` with `{ filename, contentType, size }` to get a presigned PUT URL.
2. PUT the file bytes.
3. Capture the returned `{ id, type, url, key, filename, mimeType, size }` and append to a `media[]` array.

For pasted URLs: fetch the bytes (respect link-safety rules — verify unfamiliar URLs with the user before fetching), then upload via the same flow. If a URL fails to fetch, ask the user to attach the file directly instead.

### Step 4 — Compose and confirm

Before any write that publishes publicly, show a confirmation block:

```
About to <draft | schedule | publish-now>:

Group:     Polish Pages (4 accounts)
  - facebook   @triathloninfopl
  - instagram  @triathlon_info_pl
  - threads    @triathlon_info_pl
  - twitter    @triathlon_info_pl
When:      <Now | 2026-05-19 09:00 Europe/Warsaw | Draft only>
Content:   <body, truncated to ~200 chars with [...] if longer>
Media:     <N items, names>
Mode:      <publish-now | schedule | draft>

Reply "go" to execute, or describe edits.
```

Rules:

- **Draft**: a confirmation summary is shown but the skill may proceed without an explicit "go" if the user's instruction was already unambiguous. (Drafts are reversible.)
- **Schedule**: require explicit "go".
- **Publish-now**: require explicit "go". If 5+ accounts are targeted, require a second `"yes publish to all <N>"` confirmation.

### Step 5 — Execute

- Call `create_post` with `{ content, connectionIds, media, scheduledFor?, platformContent?, platformSettings?, timezone? }`.
- If mode is `publish-now`: take the returned post id and call `publish_post`.
- If mode is `schedule`: setting `scheduledFor` on `create_post` is enough; do not call `publish_post`.
- If mode is `draft`: do not set `scheduledFor` and do not call `publish_post`.

### Step 6 — Report back

Format the result tightly:

```
Created post <id> as <status>.

Targets:
  - facebook   @triathloninfopl    queued
  - instagram  @triathlon_info_pl  queued
  - threads    @triathlon_info_pl  failed (token expired — re-auth at planpo.st)

Dashboard: https://planpo.st/posts/<id>
```

Surface per-platform results (`platformResults[]`) from the API response. **Do not swallow partial failures.**

## Examples

### Draft to a group

> "draft a post on PlanPost to my English Pages — 'New SoloOperatorStack post on building Claude skills over PlanPost. Link in bio.'"

→ Resolve "English Pages" via `list_account_groups`. Show confirmation. Call `create_post` with no `scheduledFor`. Report id.

### Publish-now to specific handles

> "post to @triathlon_info_pl on Instagram and Facebook only: 'Trening interwałowy 6x800 — kto dziś biegnie?'"

→ Skip group resolution. Filter `list_connections` to those two. Confirm (4+ rule does not apply). `create_post` → `publish_post`.

### Schedule with image

> User drops `cover.jpg`: "schedule this for tomorrow 9am to Polish Pages: 'Lista startów na weekend ...'"

→ `upload_media` for the image. Resolve Polish Pages via `get_account_group`. Resolve "tomorrow 9am" to ISO in `Europe/Warsaw`. Confirm. `create_post` with `scheduledFor`.

### Discovery

> "what groups do I have on PlanPost?"

→ `list_account_groups`. Format as table: name, account count, default flag, color.

## Safety rules

- Never publish without explicit "go" / "publish" / "yes" from the user.
- Never invent a group name — if the user names a group that doesn't exist, list what does exist and ask.
- Never silently drop a failed-per-account result — always surface it in the final report.
- Preserve the user's language and tone in the post body. Do not paraphrase.
- For pasted URLs, follow link-safety rules: confirm unfamiliar URLs with the user before fetching their contents.

## Failure modes and how to handle them

- **API key missing** → "Set `PLANPOST_API_KEY` in your MCP config. See `packages/mcp-server/README.md`."
- **`groups:read` permission missing** → "Your API key doesn't have the `groups:read` permission. Regenerate it at planpo.st/settings/api-keys with that scope checked, or pass connection IDs directly via `list_connections`."
- **Group not found** → "I don't see a group called 'X'. You have: <list>. Want me to use one of these?"
- **Ambiguous group name (HTTP 300)** → list the candidates returned by the API, ask the user to pick by id.
- **Connection inactive (token expired)** → call this out before composing; suggest re-auth in the dashboard.
- **Upload fails** → retry once, then ask the user to attach again or paste a different URL.
- **Backend 5xx on `create_post`** → do not retry automatically. Confirm with the user first to avoid duplicate posts.
