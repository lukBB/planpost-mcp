---
name: planpost
description: Draft, schedule and publish social media posts through PlanPost, the agentic social scheduler your AI agent can run, then check what went out and what worked. Use when the user wants to post, schedule, queue or bulk-plan content for Instagram, TikTok, LinkedIn, X (Twitter), Facebook, Threads or YouTube, check a post's status or a failed publish, or ask which posts drove clicks, signups or revenue. Requires the PlanPost MCP server (https://mcp.planpo.st/mcp).
license: MIT
metadata:
  homepage: https://planpo.st/mcp
---

# PlanPost

PlanPost schedules and publishes to seven social networks, reports what
failed and why, and reads back analytics and revenue (revenue per post on the
Pro plan). This skill is the operating manual for its
MCP tools. Tool names below are the ones the server exposes; your client may
prefix them (for example `mcp__planpost__create_post`).

## Before anything else

If no PlanPost tools are available, the server is not connected. Tell the user
to add `https://mcp.planpo.st/mcp` as a remote MCP server (connector) in their
agent and sign in when the browser opens. Details per client:
https://planpo.st/docs. Do not ask the user to paste an API key into
the chat.

## The rules that prevent bad posts

1. **Resolve targets, never guess them.** Call `list_account_groups` (named
   sets such as "Agency clients") or `list_connections` and use the IDs they
   return. If the user names a group or handle you cannot find, show what
   exists and ask.
2. **Draft unless told otherwise.** `create_post` with no `scheduledFor` saves
   a draft. Schedule only when the user gave a time, and publish immediately
   (`publish_post`) only when they said "now" in so many words.
3. **Say the time back.** Pass `scheduledFor` as ISO 8601 plus the user's
   `timezone`, and repeat the local time in your answer. If they gave no time
   and want one, `suggest_schedule` or `get_best_times` picks it.
4. **Approval is not a failure.** If the user turned on approval for this
   connection, a post comes back `needs_approval`: it is waiting for them in
   PlanPost under Posts, In review. Report that and stop; do not retry or
   re-create it. `get_approval_status` tells you when it clears.
5. **Read warnings.** Responses carry `warnings[]` (what will be truncated or
   dropped at publish time) and sometimes `preflight.errors[]` (the post was
   saved as a draft because it would fail). Fix what they name, then
   `update_post`.
6. **X (Twitter) takes no links.** No URL, bare domain or t.co in the post,
   any thread segment, or the first comment. Put a link-free variant in
   `platformContent.twitter`.
7. **TikTok needs a visibility choice.** A scheduled or published TikTok post
   must carry `platformSettings.tiktok.privacyLevel`. Ask the user if they
   have not said.

## Common jobs

**Post one thing to several networks**

1. `list_account_groups` → pick the group, or `list_connections` → pick IDs.
2. `preview_post` with the text to see per-network length and media problems.
3. `create_post` with `content`, `connectionIds`, optional
   `platformContent` overrides and `scheduledFor`.
4. Give the user the status and the `Open in PlanPost` link from the response.

**Plan a week or a campaign**

Use `bulk_create_posts` with one manifest instead of looping `create_post`.
Give every post the same `campaign` so `list_posts` and `list_campaigns` can
find them again. To fill the user's standing queue instead of picking times,
read `get_posting_schedule` first.

**Attach media**

Reuse before uploading: `list_media` shows what is already in the library.
For a new file, `upload_media` returns a presigned URL; upload to it, then
pass the returned asset in `media`.

Several images attached to one post publish as a carousel where the network
supports one. For a Reel or Short, attach the video and set `postType: "reel"`
or `"short"`.

**Turn an article into posts**

Read the article (open the URL the user gives you, or ask them to paste it) →
write per-network variants (use `get_brand_voice_prompt` when a brand voice
exists) → `create_post` as drafts.

**A post failed**

`get_post` → read `platformResults[]`: `errorClass`, `error`, `fix`.
`retry_failed` re-queues only transient failures and never re-posts a network
that already went out. Failures that need the user (reconnect an account,
choose TikTok visibility) come back with the fix to relay.

**What worked?**

`get_analytics` for reach and engagement, `get_revenue_overview` for revenue,
signups and clicks attributed to posts. Lead with the posts that earned
money, not the ones with the most likes.

## Limits to respect

- Calls count against the user's monthly API allowance; prefer one
  `bulk_create_posts` over many `create_post` calls, and do not poll a status
  faster than every few seconds.
- A tool that answers with a missing-permission error means the user did not
  grant that scope. Say which capability is missing; do not look for a
  workaround.
- Connecting a new social account needs a human in a browser:
  `get_connection_link` returns the link to send them.
