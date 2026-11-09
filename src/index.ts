#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { z } from "zod";
import { annotationsFor } from "./annotations.js";
import {
  AccessTokenVerifier,
  IntrospectionUnavailableError,
  InvalidTokenError,
  bearerChallenge,
  loadOAuthSettings,
  protectedResourceMetadata,
  upstreamHeaders,
  type Credential,
} from "./oauth.js";

const ENV_API_KEY = process.env.PLANPOST_API_KEY;
const BASE_URL = process.env.PLANPOST_API_URL || "https://api.planpo.st";

// Single source of truth for the version: package.json ships in every tarball,
// and dist/index.js always sits one level below it. Hardcoding it here meant
// the two drifted on the first release that forgot to update both.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const SERVER_INFO = { name: "planpost", version };

// In HTTP mode each request carries its own credential (an API key, or an
// OAuth grant resolved from the access token); the AsyncLocalStorage context
// survives across the awaits inside tool handlers, so concurrent requests
// with different credentials can't bleed into each other. Stdio mode falls
// back to the env key.
const requestCredential = new AsyncLocalStorage<Credential>();

function resolveCredential(): Credential {
  const credential = requestCredential.getStore();
  if (credential) return credential;
  if (!ENV_API_KEY) {
    throw new Error(
      "No PlanPost API key: set PLANPOST_API_KEY (stdio) or send Authorization: Bearer pk_... (http)"
    );
  }
  return { kind: "key", key: ENV_API_KEY };
}

// ─── API Client ───

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${BASE_URL}/api/public/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...upstreamHeaders(resolveCredential()),
      ...options.headers,
    },
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `API error ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

/**
 * Renders the API's advisory `warnings[]` as a readable block. These never
 * block a write — they flag what will happen at publish time (truncation,
 * dropped media, a flag that lost to postType) so the caller can fix it now.
 */
function formatWarnings(warnings: unknown): string {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  const lines = warnings.map((w: any) => `  - [${w.code}]${w.platform ? ` ${w.platform}:` : ""} ${w.message}`);
  return `\n\n⚠️  ${warnings.length} warning(s):\n${lines.join("\n")}`;
}

/**
 * Renders the API's `preflight.errors[]` — the checks that would make the
 * post fail at its slot. When present the post was saved as a DRAFT, not
 * scheduled; fix the listed fields and call update_post (or create again).
 */
function formatPreflight(preflight: unknown): string {
  const p = preflight as { errors?: any[] } | undefined;
  if (!p || !Array.isArray(p.errors) || p.errors.length === 0) return "";
  const lines = p.errors.map(
    (e: any) => `  - [${e.code}] ${e.platform}: ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`,
  );
  return `\n\n⛔ Saved as DRAFT — ${p.errors.length} issue(s) block scheduling:\n${lines.join("\n")}`;
}

/** Renders the dashboard deep links returned alongside a created/updated post. */
function formatLinks(links: unknown): string {
  if (!links || typeof links !== "object") return "";
  const { edit, view } = links as { edit?: string; view?: string };
  if (!edit && !view) return "";
  return `\n\nOpen in PlanPost:${edit ? `\n  Edit: ${edit}` : ""}${view ? `\n  View: ${view}` : ""}`;
}

// ─── MCP Server ───

// Tool registration is a function so HTTP mode can build a fresh server per
// request (stateless transport); stdio builds one at startup.
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server);
  return server;
}

// ─── Tools ───

function registerTools(target: McpServer): void {
// Every tool below is registered through this shim so its annotations
// (title, read-only / destructive hints) come from annotations.ts.
const server = {
  tool: ((name: string, description: string, schema: any, handler: any) =>
    target.tool(name, description, schema, annotationsFor(name), handler)) as McpServer["tool"],
};

server.tool(
  "list_posts",
  "List your scheduled and published social media posts. Filter by status, platform, campaign, label, post type, or free text.",
  {
    // `needs_approval` is a first-class status, not an internal one: a post
    // parked for human sign-off is exactly what an agent needs to be able to
    // find again after submitting it.
    status: z.enum(["draft", "needs_approval", "scheduled", "processing", "published", "partially_published", "failed", "cancelled"]).optional().describe("Filter by post status ('needs_approval' = waiting on human sign-off; 'partially_published' = some platforms live, at least one failed — see platformResults[].error and .fix)"),
    platform: z.string().optional().describe("Filter by platform (instagram, twitter, linkedin, etc.)"),
    campaign: z.string().optional().describe("Filter by campaign tag, e.g. 'garmin-cirqa-2026' (matches utm.campaign; slugified automatically)"),
    label: z.string().optional().describe("Filter by internal label (case-insensitive substring), e.g. 'Garmin CIRQA'"),
    postType: z.enum(["post", "reel", "short", "story", "thread"]).optional().describe("Filter by post type"),
    search: z.string().optional().describe("Free-text search across content, thread segments and label"),
    sort: z.enum(["newest", "oldest", "scheduled"]).optional().describe("Sort order: newest (default), oldest, or scheduled (soonest scheduled first)"),
    page: z.number().optional().describe("Page number (default: 1)"),
    limit: z.number().optional().describe("Posts per page (default: 20, max: 100)"),
  },
  async ({ status, platform, campaign, label, postType, search, sort, page, limit }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (platform) params.set("platform", platform);
    if (campaign) params.set("campaign", campaign);
    if (label) params.set("label", label);
    if (postType) params.set("postType", postType);
    if (search) params.set("search", search);
    if (sort) params.set("sort", sort);
    if (page) params.set("page", String(page));
    if (limit) params.set("limit", String(limit));

    const data = await api(`/posts?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_post",
  "Get details of a specific post by ID.",
  {
    id: z.string().describe("Post ID"),
  },
  async ({ id }) => {
    const data = await api(`/posts/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "create_post",
  "Create a new social media post. Saves as draft or schedules it for a specific time. X (Twitter): nothing sent to X may contain a link (URL, bare domain or t.co) — not the post, any thread segment, or a first comment (posted to X as a reply). The X API bills each link post at $0.20 vs $0.015, so the API rejects them; put a link-free version in platformContent.twitter.",
  {
    content: z.string().describe("Post text content"),
    connectionIds: z.array(z.string()).describe("Array of social connection IDs to post to. Use list_connections or list_account_groups to find IDs."),
    platformContent: z.record(z.string(), z.string()).optional().describe("Per-platform content overrides, e.g. { twitter: 'shorter version', linkedin: 'longer version' }"),
    platformSettings: z.record(z.string(), z.any()).optional().describe("Per-platform settings, e.g. { instagram: { isReel: true }, youtube: { title: '...', visibility: 'public' } }. TikTok: a scheduled or published post MUST carry { tiktok: { privacyLevel } } with one of PUBLIC_TO_EVERYONE, MUTUAL_FOLLOW_FRIENDS, FOLLOWER_OF_CREATOR, SELF_ONLY (TikTok makes the user choose who can view each video; without it the API returns 400). Optional tiktok flags: disableComment, disableDuet, disableStitch (default true = off), brandedContent, yourBrand."),
    postType: z.enum(["post", "reel", "short", "story", "thread"]).optional().describe("Explicit post type (clearer than platformSettings flags, and takes precedence over them). 'reel' needs Instagram/Facebook; 'short' needs YouTube/Instagram/TikTok/Facebook; 'story' needs Instagram/Facebook; 'thread' is X/Twitter-only and requires threadSegments. Defaults to 'post', or is inferred from platformSettings flags (e.g. { instagram: { isReel: true } } → reel). NOTE: a carousel is NOT a postType — attach media with type 'carousel' or use generate_carousel/render_carousel."),
    threadSegments: z.array(z.string()).optional().describe("Ordered tweet segments for a thread (only used when postType='thread', X/Twitter-only). 2–25 segments, each 1–280 characters."),
    label: z.string().optional().describe("Internal working name shown in the PlanPost dashboard list, e.g. 'Garmin CIRQA - IG Carousel'. Never published to any platform — it just makes a campaign's drafts tellable apart. Highly recommended when creating several posts at once."),
    campaign: z.string().optional().describe("Campaign tag, e.g. 'garmin-cirqa-2026' (slugified automatically). Sets utm.campaign and derives a utm.content token from the format (e.g. 'ig-carousel', 'fb-static'). Group/filter/bulk-delete by this with list_campaigns, list_posts({campaign}) and delete_posts({campaign})."),
    schedule: z.string().optional().describe("Natural-language schedule, easier and safer than hand-building ISO: 'now', 'draft', 'today 20:30 Europe/Warsaw', 'tomorrow 07:00', 'in 2 hours', 'next week'. Takes precedence over scheduledFor. A timezone may be appended to wall-clock forms; otherwise `timezone` (or UTC) applies."),
    scheduledFor: z.string().optional().describe("ISO 8601 datetime to schedule the post (e.g. '2026-04-10T14:00:00Z'). Omit for draft. Prefer `schedule` for anything other than an exact instant."),
    timezone: z.string().optional().describe("Timezone for scheduling (default: UTC)"),
    media: z.array(z.object({
      id: z.string(),
      type: z.enum(["image", "video"]),
      url: z.string(),
      key: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
    })).optional().describe("Media attachments shared across every platform (use upload_media first to get URLs). Override per-platform via platformMedia."),
    platformMedia: z.record(z.string(), z.array(z.object({
      id: z.string(),
      type: z.enum(["image", "video"]),
      url: z.string(),
      key: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
    }))).optional().describe("Per-platform media overrides, e.g. { instagram: [<image>], twitter: [] } — instagram gets the image, twitter publishes with no media. Absent keys fall back to the shared `media` array. Empty `[]` is a meaningful 'no media on this platform'."),
    utm: z.object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      content: z.string().optional(),
    }).optional().describe("Per-post UTM tag overrides applied when attribution mode is utm. Each field can include the `{platform}` placeholder (substituted per platform at publish time). Letters, digits, `-`, `_`, `.` only. Any field omitted falls back to the user's UTM defaults configured in Settings, then to a hardcoded fallback. Example: { campaign: \"summer-2026\", content: \"weekly-tips\" }."),
  },
  async ({ content, connectionIds, platformContent, platformSettings, postType, threadSegments, label, campaign, schedule, scheduledFor, timezone, media, platformMedia, utm }) => {
    const body: any = { content, connectionIds };
    if (platformContent) body.platformContent = platformContent;
    if (platformSettings) body.platformSettings = platformSettings;
    if (postType) body.postType = postType;
    if (threadSegments) body.threadSegments = threadSegments;
    if (label) body.label = label;
    if (campaign) body.campaign = campaign;
    if (schedule) body.schedule = schedule;
    if (scheduledFor) body.scheduledFor = scheduledFor;
    if (timezone) body.timezone = timezone;
    if (media) body.media = media;
    if (platformMedia) body.platformMedia = platformMedia;
    if (utm) body.utm = utm;

    const data = await api("/posts", { method: "POST", body: JSON.stringify(body) });
    const post = data.data;
    const status = post.status === "published" || post.status === "processing"
      ? "Publishing now"
      : post.scheduledFor
        ? `Scheduled for ${post.scheduledFor}`
        : "Saved as draft";
    return { content: [{ type: "text" as const, text: `Post created (${status}).${formatPreflight(data.preflight)}${formatWarnings(data.warnings)}${formatLinks(data.links)}\n\n${JSON.stringify(post, null, 2)}` }] };
  }
);

server.tool(
  "preview_post",
  "Show exactly what each platform will receive for a post: the body after platformContent overrides, the attachments after platformMedia overrides, character count vs the platform limit, whether links are clickable, and the warnings for that platform. Use this to check a post (especially carousels, videos and multi-platform posts) BEFORE scheduling or publishing. Returns structured data plus a dashboard link for the visual preview — it does not return screenshots.",
  {
    id: z.string().describe("Post ID to preview"),
  },
  async ({ id }) => {
    const data = await api(`/posts/${id}/preview`);
    const p = data.data;
    const blocks = (p.platforms ?? []).map((pl: any) => {
      const limit = pl.characterLimit ? `${pl.characterCount}/${pl.characterLimit}${pl.withinLimit ? "" : "  ⚠️ OVER LIMIT"}` : `${pl.characterCount} chars`;
      const media = pl.mediaCount === 0
        ? `no media${pl.mediaSource === "override" ? " (text-only override)" : ""}`
        : `${pl.mediaCount} ${pl.mediaCount === 1 ? "item" : "items"} (${pl.media.map((m: any) => m.filename ?? m.type).join(", ")})`;
      const warn = pl.warnings?.length
        ? `\n  warnings:\n${pl.warnings.map((w: any) => `    - [${w.code}] ${w.message}`).join("\n")}`
        : "";
      return [
        `── ${pl.platform.toUpperCase()} ─────────────`,
        `  text (${pl.contentSource}): ${limit}${pl.linksClickable ? "" : "  [links NOT clickable]"}`,
        `  media (${pl.mediaSource}): ${media}`,
        pl.threadSegments ? `  thread: ${pl.threadSegments.length} segment(s)` : "",
        warn,
        "",
        pl.content.length > 400 ? `${pl.content.slice(0, 400)}…` : pl.content,
      ].filter(Boolean).join("\n");
    });

    const blockedLine = p.preflight && p.preflight.ok === false
      ? `\n⛔ ${p.preflight.errors.length} issue(s) block scheduling — fix them with update_post:\n${p.preflight.errors.map((e: any) => `  - [${e.code}] ${e.platform}: ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`).join("\n")}\n`
      : "";
    const header = `Preview — postType=${p.postType}${p.label ? ` · ${p.label}` : ""}${p.campaign ? ` · campaign=${p.campaign}` : ""}${p.status ? ` · status=${p.status}` : ""}${blockedLine}`;
    return {
      content: [{
        type: "text" as const,
        text: `${header}\n\n${blocks.join("\n\n")}${formatLinks(data.links)}\n\n${JSON.stringify(p, null, 2)}`,
      }],
    };
  }
);

server.tool(
  "bulk_create_posts",
  "Create a whole campaign of posts from one manifest. Each entry accepts the same fields as create_post; `defaults` supplies values shared by every entry (campaign, connectionIds, timezone, ...) so you don't repeat them. Rows are independent — one bad row fails alone and the rest still get created. Max 50 per call. Returns a per-row result with ids, warnings and edit links. X (Twitter): nothing sent to X may contain a link (URL, bare domain or t.co) — not the post, any thread segment, or a first comment (posted to X as a reply). The X API bills each link post at $0.20 vs $0.015, so the API rejects them; put a link-free version in platformContent.twitter.",
  {
    posts: z.array(z.record(z.string(), z.any())).describe("Array of post payloads. Each accepts every create_post field: content, connectionIds, platformContent, platformSettings, postType, threadSegments, label, campaign, schedule/scheduledFor, media, platformMedia, utm."),
    defaults: z.record(z.string(), z.any()).optional().describe("Fields merged into every entry before its own values (which always win). Ideal for campaign, connectionIds and timezone."),
  },
  async ({ posts, defaults }) => {
    const body: any = { posts };
    if (defaults) body.defaults = defaults;

    const data = await api("/posts/bulk", { method: "POST", body: JSON.stringify(body) });
    const d = data.data;
    const lines = (d.results ?? []).map((r: any) =>
      r.ok
        ? `  #${r.index} OK  ${r.label ?? "(no label)"} → ${r.id} [${r.status}]${Array.isArray(r.warnings) && r.warnings.length ? ` (${r.warnings.length} warning(s))` : ""}${
            Array.isArray(r.preflightErrors) && r.preflightErrors.length
              ? `\n      ⛔ saved as draft: ${r.preflightErrors.map((e: any) => `[${e.code}] ${e.message}${e.fix ? ` Fix: ${e.fix}` : ""}`).join(" | ")}`
              : ""
          }`
        : `  #${r.index} FAILED  ${r.error}`,
    );
    return {
      content: [{
        type: "text" as const,
        text: `Created ${d.created}/${d.total} post(s)${d.failed ? `, ${d.failed} failed` : ""}.\n${lines.join("\n")}\n\n${JSON.stringify(d, null, 2)}`,
      }],
    };
  }
);

server.tool(
  "list_campaigns",
  "List campaign bundles — every campaign tag in use, with post counts by status, the platforms involved and the next scheduled time. Use this to see what a campaign contains before editing or deleting it.",
  {},
  async () => {
    const data = await api("/posts/campaigns");
    const rows = (data.data ?? []).map((c: any) =>
      `  ${c.campaign}: ${c.total} post(s) [draft ${c.byStatus.draft}, scheduled ${c.byStatus.scheduled}, published ${c.byStatus.published}, failed ${c.byStatus.failed}] on ${c.platforms.join(", ") || "—"}`,
    );
    return { content: [{ type: "text" as const, text: `${rows.length} campaign(s):\n${rows.join("\n")}\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "delete_posts",
  "Bulk-delete posts matching a filter — e.g. every draft in a campaign. SAFETY: a filter is required (it will never delete everything), published and processing posts are always excluded, and it runs as a DRY RUN unless confirm:true. Always call once without confirm to see what matches, show the user, then confirm.",
  {
    campaign: z.string().optional().describe("Delete posts tagged with this campaign, e.g. 'garmin-cirqa-2026'"),
    label: z.string().optional().describe("Delete posts whose internal label matches (case-insensitive substring)"),
    ids: z.array(z.string()).optional().describe("Explicit post IDs to delete"),
    status: z.enum(["draft", "scheduled", "failed", "cancelled", "needs_approval"]).optional().describe("Restrict to one status, e.g. 'draft'. Defaults to everything except published/processing."),
    confirm: z.boolean().optional().describe("false/omitted = dry run listing what WOULD be deleted. true = actually delete. Always dry-run first."),
  },
  async ({ campaign, label, ids, status, confirm }) => {
    const body: any = {};
    if (campaign) body.campaign = campaign;
    if (label) body.label = label;
    if (ids) body.ids = ids;
    if (status) body.status = status;
    if (confirm) body.confirm = true;

    const data = await api("/posts/bulk-delete", { method: "POST", body: JSON.stringify(body) });
    const d = data.data;
    if (d.dryRun) {
      const rows = (d.posts ?? []).map((p: any) => `  ${p.id} [${p.status}] ${p.label ?? ""} ${p.campaign ? `(${p.campaign})` : ""}`);
      return { content: [{ type: "text" as const, text: `DRY RUN — ${d.matched} post(s) would be deleted:\n${rows.join("\n")}\n\nRe-run with confirm:true to delete.` }] };
    }
    return { content: [{ type: "text" as const, text: `Deleted ${d.deleted} of ${d.matched} matched post(s).` }] };
  }
);

server.tool(
  "list_media",
  "List media you already uploaded, so you can reuse an asset instead of uploading it again. Each item comes back already shaped for create_post's `media` array — pass it straight through.",
  {
    type: z.enum(["image", "video"]).optional().describe("Filter by media type"),
    search: z.string().optional().describe("Filter by filename (case-insensitive substring), e.g. 'cirqa'"),
    page: z.number().optional().describe("Page number (default: 1)"),
    limit: z.number().optional().describe("Items per page (default: 20, max: 100)"),
  },
  async ({ type, search, page, limit }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (search) params.set("search", search);
    if (page) params.set("page", String(page));
    if (limit) params.set("limit", String(limit));

    const data = await api(`/media?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "update_post",
  "Update a draft or scheduled post. X (Twitter): nothing sent to X may contain a link (URL, bare domain or t.co) — not the post, any thread segment, or a first comment (posted to X as a reply). The X API bills each link post at $0.20 vs $0.015, so the API rejects them; put a link-free version in platformContent.twitter.",
  {
    id: z.string().describe("Post ID to update"),
    content: z.string().optional().describe("New post text content"),
    connectionIds: z.array(z.string()).optional().describe("New connection IDs"),
    platformContent: z.record(z.string(), z.string()).optional().describe("Per-platform content overrides"),
    platformSettings: z.record(z.string(), z.any()).optional().describe("Per-platform settings (e.g. { instagram: { isReel: true } }). TikTok posts need { tiktok: { privacyLevel } } (PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY) before they can be scheduled — this is how to repair a TikTok post that was created without one."),
    postType: z.enum(["post", "reel", "short", "story", "thread"]).optional().describe("Explicit post type; takes precedence over platformSettings flags. Same platform rules as create_post ('thread' is X/Twitter-only and needs threadSegments). Omit to leave the current type unchanged — a plain edit never downgrades a reel/short/story."),
    threadSegments: z.array(z.string()).optional().describe("Ordered tweet segments for a thread (postType='thread'). 2–25 segments, each 1–280 characters."),
    label: z.string().nullable().optional().describe("Internal working name shown in the dashboard. Pass null to clear. Never published."),
    campaign: z.string().nullable().optional().describe("Re-tag this post's campaign (sets utm.campaign). Pass null to clear."),
    schedule: z.string().optional().describe("Natural-language reschedule: 'draft' (unschedule), 'today 20:30 Europe/Warsaw', 'tomorrow 07:00', 'in 2 hours', 'next week same time' (anchors on the post's current scheduled time). Use publish_post to publish immediately — 'now' is rejected here."),
    media: z.array(z.object({
      id: z.string(),
      type: z.enum(["image", "video"]),
      url: z.string(),
      key: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
    })).optional().describe("Replace the shared media array. Omit to leave existing media alone."),
    platformMedia: z.record(z.string(), z.array(z.object({
      id: z.string(),
      type: z.enum(["image", "video"]),
      url: z.string(),
      key: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      size: z.number(),
    }))).nullable().optional().describe("Per-platform media overrides. Pass `null` to clear all overrides (every platform uses the shared `media` array). Omit to leave overrides unchanged."),
    utm: z.object({
      source: z.string().optional(),
      medium: z.string().optional(),
      campaign: z.string().optional(),
      content: z.string().optional(),
    }).nullable().optional().describe("Per-post UTM overrides. Pass `null` to clear all overrides (use user defaults). Omit to leave alone."),
    scheduledFor: z.string().optional().describe("New schedule time (ISO 8601), or empty string to unschedule"),
    timezone: z.string().optional().describe("Timezone"),
  },
  async ({ id, content, connectionIds, platformContent, platformSettings, postType, threadSegments, label, campaign, schedule, media, platformMedia, utm, scheduledFor, timezone }) => {
    const body: any = {};
    if (content !== undefined) body.content = content;
    if (connectionIds !== undefined) body.connectionIds = connectionIds;
    if (platformContent !== undefined) body.platformContent = platformContent;
    if (platformSettings !== undefined) body.platformSettings = platformSettings;
    if (postType !== undefined) body.postType = postType;
    if (threadSegments !== undefined) body.threadSegments = threadSegments;
    if (label !== undefined) body.label = label;
    if (campaign !== undefined) body.campaign = campaign;
    if (schedule !== undefined) body.schedule = schedule;
    if (media !== undefined) body.media = media;
    if (platformMedia !== undefined) body.platformMedia = platformMedia;
    if (utm !== undefined) body.utm = utm;
    if (scheduledFor !== undefined) body.scheduledFor = scheduledFor;
    if (timezone !== undefined) body.timezone = timezone;

    const data = await api(`/posts/${id}`, { method: "PUT", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Post updated (${data.data?.status ?? "unknown"}).${formatPreflight(data.preflight)}${formatWarnings(data.warnings)}${formatLinks(data.links)}\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "delete_post",
  "Delete a post.",
  {
    id: z.string().describe("Post ID to delete"),
  },
  async ({ id }) => {
    await api(`/posts/${id}`, { method: "DELETE" });
    return { content: [{ type: "text" as const, text: `Post ${id} deleted.` }] };
  }
);

server.tool(
  "retry_failed",
  "Retry the platforms that failed on a failed or partially_published post. Only failures classified transient (platform outage, rate limit, network) are re-queued; failures that need the user — reconnect an account, top up X API credits, choose TikTok visibility — or that the payload caused are refused and returned with their fix. Platforms that already went out are never re-posted. Check get_post → platformResults[].errorClass / .fix first.",
  {
    id: z.string().describe("Post ID with status failed or partially_published"),
  },
  async ({ id }) => {
    let data: any;
    try {
      data = await api(`/posts/${id}/retry`, { method: "POST" });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Retry refused: ${e?.message ?? e}` }] };
    }
    const retried = Array.isArray(data.retried) && data.retried.length ? data.retried.join(", ") : "nothing";
    const blocked = Array.isArray(data.blocked) && data.blocked.length
      ? `\n\nNot retried (a retry would fail the same way):\n${data.blocked.map((b: any) => `  - ${b.provider}: [${b.code}] ${b.error ?? ""}${b.fix ? ` Fix: ${b.fix}` : ""}`).join("\n")}`
      : "";
    return { content: [{ type: "text" as const, text: `Retrying: ${retried}.${blocked}${formatLinks(data.links)}\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "get_delivery_report",
  "The morning check: everything that needs the user's attention about delivery. Posts that failed or partially failed in the last `days` days with each platform's error and fix, connections whose health went dead or degraded, pending approvals whose slot is within 48 h or already passed, approvals that expired (their posts are drafts again), scheduled posts in the next 7 days that would fail preflight if dispatched now, auto-import content sources that stopped fetching, and posting queues with free slots this week while drafts wait. Same data as the 08:00 digest e-mail. Empty `hasIssues: false` means nothing to do.",
  {
    days: z.number().int().min(1).max(30).optional().describe("Look-back window in days for failures and connection changes (default 1)"),
  },
  async ({ days }) => {
    const data = await api(`/delivery-report?days=${days ?? 1}`);
    const r = data.data ?? {};
    const label = (p: string) => p;
    const lines: string[] = [];
    if (!r.hasIssues) {
      lines.push(`All clear for the last ${r.windowDays ?? days ?? 1} day(s): no failed posts, no connection changes, no approvals due or expired, no upcoming post fails preflight, no stale content source, no empty queue slots with drafts waiting.`);
    } else {
      if (Array.isArray(r.failedPosts) && r.failedPosts.length) {
        lines.push(`Did not go out (${r.failedPosts.length}):`);
        for (const p of r.failedPosts) {
          lines.push(`  - ${p.postId} [${p.status}${p.status === "partially_published" ? ` ${p.liveCount}/${p.targetCount} live` : ""}] ${p.content}`);
          for (const f of p.failures ?? []) {
            lines.push(`      ${label(f.provider)}: [${f.errorCode ?? f.errorClass ?? "failed"}] ${f.error ?? ""}${f.fix ? ` Fix: ${f.fix}` : ""}`);
          }
        }
      }
      if (Array.isArray(r.connections) && r.connections.length) {
        lines.push(`Connections (${r.connections.length}):`);
        for (const c of r.connections) {
          lines.push(`  - ${c.provider} @${c.username} is ${c.status}${c.reason ? ` [${c.reason}]` : ""}${c.lastError ? `: ${c.lastError}` : ""}${c.status === "dead" ? " Fix: reconnect on /connections." : ""}`);
        }
      }
      if (Array.isArray(r.approvals) && r.approvals.length) {
        lines.push(`Approvals (${r.approvals.length}):`);
        for (const a of r.approvals) {
          lines.push(`  - ${a.approvalId} post ${a.postId} ${a.overdue ? "SLOT PASSED" : `due ${a.scheduledFor}`}${a.reviewerEmail ? ` (reviewer ${a.reviewerEmail})` : ""}: ${a.content}`);
        }
      }
      if (Array.isArray(r.expiredApprovals) && r.expiredApprovals.length) {
        lines.push(`Approvals that expired, posts back to draft (${r.expiredApprovals.length}):`);
        for (const a of r.expiredApprovals) {
          lines.push(`  - ${a.approvalId} post ${a.postId}${a.scheduledFor ? ` (slot was ${a.scheduledFor})` : ""}${a.reviewerEmail ? ` reviewer ${a.reviewerEmail}` : ""}: ${a.content} Fix: reschedule with update_post and resubmit, or publish_post.`);
        }
      }
      if (Array.isArray(r.atRisk) && r.atRisk.length) {
        lines.push(`Scheduled posts that will fail (${r.atRisk.length}):`);
        for (const p of r.atRisk) {
          lines.push(`  - ${p.postId} at ${p.scheduledFor}: ${p.content}`);
          for (const i of p.issues ?? []) {
            lines.push(`      ${i.platform}: [${i.code}] ${i.message}${i.fix ? ` Fix: ${i.fix}` : ""}`);
          }
        }
      }
    }
    if (Array.isArray(r.staleSources) && r.staleSources.length) {
      lines.push(`Content sources that stopped importing (${r.staleSources.length}):`);
      for (const src of r.staleSources) {
        lines.push(`  - ${src.sourceId} ${src.name} (${src.frequency}, last fetch ${src.lastFetchedAt ?? "never"}, ${src.staleHours}h ago). Fix: fetch_source_content, then check the URL/credentials if it fails.`);
      }
    }
    if (Array.isArray(r.staleQueues) && r.staleQueues.length) {
      lines.push(`Posting queues with empty slots while drafts wait (${r.staleQueues.length}):`);
      for (const q of r.staleQueues) {
        lines.push(`  - ${q.groupName ? `group ${q.groupName} (${q.groupId})` : "global queue"}: ${q.emptySlots} of ${q.totalSlots} slots free in the next ${q.horizonDays} days, ${q.drafts} draft(s). Fix: suggest_schedule / update_post with a scheduledFor from get_posting_schedule.`);
      }
    }
    return { content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${JSON.stringify(r, null, 2)}` }] };
  }
);

server.tool(
  "publish_post",
  "Publish a draft or scheduled post immediately to all connected platforms. X (Twitter): nothing sent to X may contain a link (URL, bare domain or t.co) — not the post, any thread segment, or a first comment (posted to X as a reply). The X API bills each link post at $0.20 vs $0.015, so the API rejects them; put a link-free version in platformContent.twitter.",
  {
    id: z.string().describe("Post ID to publish now"),
  },
  async ({ id }) => {
    const data = await api(`/posts/${id}/publish`, { method: "POST" });
    return { content: [{ type: "text" as const, text: `Post is being published.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "list_connections",
  "List all connected social media accounts (Instagram, Twitter, LinkedIn, etc.).",
  {},
  async () => {
    const data = await api("/connections");
    const connections = data.data;
    // Health comes from the publishing worker and token refresher: a `dead`
    // account fails preflight for every post that targets it until `reason`
    // is fixed, so say so next to the name instead of burying it in JSON.
    const healthTag = (c: any): string => {
      const h = c.health;
      if (!h || h.status === "healthy") return "";
      if (h.status === "degraded") return "  ⚠️ last publish failed, will retry";
      return `  ⛔ cannot publish${h.reason ? ` [${h.reason}]` : ""}${h.lastError ? `: ${String(h.lastError).slice(0, 120)}` : ""}`;
    };
    const summary = connections.map((c: any) =>
      `${c.provider} — ${c.metadata?.accountName || c.providerUsername} (ID: ${c.id})${healthTag(c)}`
    ).join("\n");
    const dead = connections.filter((c: any) => c.health?.status === "dead").length;
    const headline = `${connections.length} connected accounts${dead ? `, ${dead} cannot publish until fixed` : ""}:`;
    return { content: [{ type: "text" as const, text: `${headline}\n\n${summary}\n\nFull data:\n${JSON.stringify(connections, null, 2)}` }] };
  }
);

server.tool(
  "list_account_groups",
  "List account groups the user has set up in PlanPost (e.g. 'Polish Pages', 'English Pages'). Each group bundles social connections so you can target multiple accounts in one create_post call. Returns id, name, connectionCount, isDefault, and the underlying connections.",
  {},
  async () => {
    const data = await api("/account-groups");
    const groups = data.data;
    if (!groups || groups.length === 0) {
      return { content: [{ type: "text" as const, text: "No account groups configured. Targets must be specific connectionIds (see list_connections)." }] };
    }
    const summary = groups.map((g: any) =>
      `${g.isDefault ? "★ " : "  "}${g.name} (${g.connectionCount} accounts, id: ${g.id})`
    ).join("\n");
    return { content: [{ type: "text" as const, text: `${groups.length} account groups:\n\n${summary}\n\nFull data:\n${JSON.stringify(groups, null, 2)}` }] };
  }
);

server.tool(
  "get_account_group",
  "Fetch one account group by id, name, or default flag. Returns the group's connectionIds[] so they can be passed straight to create_post. Name matching is case-insensitive (exact match preferred, substring fallback). If the name is ambiguous the server returns 300 with the candidates.",
  {
    idOrName: z.string().optional().describe("Mongo ObjectId or group name (e.g. 'Polish Pages'). Omit when using default=true."),
    default: z.boolean().optional().describe("When true, fetch the team's default group and ignore idOrName."),
  },
  async ({ idOrName, default: useDefault }) => {
    if (!useDefault && !idOrName) {
      throw new Error("Provide idOrName or set default=true.");
    }
    const path = useDefault ? "/account-groups/default" : `/account-groups/${encodeURIComponent(idOrName as string)}`;
    const data = await api(path);
    const group = data.data;
    const connectionIds = (group.connections || []).map((c: any) => c.id);
    return {
      content: [{
        type: "text" as const,
        text: `Group: ${group.name}${group.isDefault ? " (default)" : ""}\nConnections (${group.connectionCount}): ${connectionIds.join(", ")}\n\nFull data:\n${JSON.stringify(group, null, 2)}`,
      }],
    };
  }
);

server.tool(
  "create_account_group",
  "Create a named account group (e.g. 'Polish Pages') bundling social connections, so future posts can target the whole set at once.",
  {
    name: z.string().describe("Group name"),
    description: z.string().optional(),
    color: z.string().optional().describe("Display color (hex)"),
    connectionIds: z.array(z.string()).optional().describe("Social connection IDs to include (see list_connections)"),
    isDefault: z.boolean().optional().describe("Make this the team's default group"),
  },
  async ({ name, description, color, connectionIds, isDefault }) => {
    const body: any = { name };
    if (description) body.description = description;
    if (color) body.color = color;
    if (connectionIds) body.connectionIds = connectionIds;
    if (isDefault !== undefined) body.isDefault = isDefault;
    const data = await api("/account-groups", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Group created.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "update_account_group",
  "Update an account group's name, description, color, default flag, or replace its full connection list.",
  {
    id: z.string().describe("Group ID"),
    name: z.string().optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    isDefault: z.boolean().optional(),
    connectionIds: z.array(z.string()).optional().describe("REPLACES the group's connections when provided"),
  },
  async ({ id, ...rest }) => {
    const body: any = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    const data = await api(`/account-groups/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Group updated.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "delete_account_group",
  "Delete an account group (does not disconnect the underlying social accounts).",
  {
    id: z.string().describe("Group ID"),
  },
  async ({ id }) => {
    await api(`/account-groups/${id}`, { method: "DELETE" });
    return { content: [{ type: "text" as const, text: `Group ${id} deleted.` }] };
  }
);

server.tool(
  "add_connections_to_group",
  "Add social connections to an existing account group.",
  {
    id: z.string().describe("Group ID"),
    connectionIds: z.array(z.string()).describe("Connection IDs to add"),
  },
  async ({ id, connectionIds }) => {
    const data = await api(`/account-groups/${id}/connections`, {
      method: "POST",
      body: JSON.stringify({ connectionIds }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "remove_connections_from_group",
  "Remove social connections from an account group.",
  {
    id: z.string().describe("Group ID"),
    connectionIds: z.array(z.string()).describe("Connection IDs to remove"),
  },
  async ({ id, connectionIds }) => {
    const data = await api(`/account-groups/${id}/connections`, {
      method: "DELETE",
      body: JSON.stringify({ connectionIds }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_connection_link",
  "Generate a link the user can open in their browser to connect a new social account (OAuth needs a human — send them this link).",
  {
    provider: z.enum(["instagram", "facebook", "twitter", "linkedin", "youtube", "tiktok", "threads"]).describe("Platform to connect"),
  },
  async ({ provider }) => {
    const data = await api(`/connections/connect-link?provider=${provider}`);
    return { content: [{ type: "text" as const, text: `${data.data.url}\n\n${data.data.instructions}` }] };
  }
);

server.tool(
  "submit_for_approval",
  "Submit a post for human approval. Use this when your API key requires approval (or whenever you want a human to sign off before publishing). Returns an approve link and an approval ID to poll. On approval the post auto-schedules if it has a scheduledFor time.",
  {
    postId: z.string().describe("Post ID to submit (create it first with create_post)"),
    reviewerEmail: z.string().optional().describe("E-mail the approve link to a specific reviewer (e.g. the client). Omit to notify the team's approvers in-app."),
    expiresInDays: z.number().optional().describe("Auto-expire the approval link after N days"),
    supersede: z.boolean().optional().describe("If the post already has a pending approval, replace it (default false → returns 409)"),
  },
  async ({ postId, reviewerEmail, expiresInDays, supersede }) => {
    const body: any = { postId, autoPublishOnApprove: true };
    if (reviewerEmail) body.reviewerEmail = reviewerEmail;
    if (expiresInDays) body.expiresInDays = expiresInDays;
    if (supersede !== undefined) body.supersede = supersede;
    const data = await api("/approvals", { method: "POST", body: JSON.stringify(body) });
    const d = data.data;
    return { content: [{ type: "text" as const, text: `Submitted for approval.\nApprove link: ${d.approveUrl}\nApproval ID: ${d.id} (poll with get_approval_status)\n\n${JSON.stringify(d, null, 2)}` }] };
  }
);

server.tool(
  "list_pending_approvals",
  "List posts waiting for approval (and their outcomes). Filter by status to build a review queue.",
  {
    status: z.string().optional().describe("Comma-separated: pending, approved, rejected, changes_requested, expired, revoked. Default: all."),
  },
  async ({ status }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const data = await api(`/approvals?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_approval_status",
  "Check whether a human has decided on a submitted approval yet (pending / approved / rejected / changes_requested). Poll this after submit_for_approval.",
  {
    approvalId: z.string().describe("Approval ID from submit_for_approval"),
  },
  async ({ approvalId }) => {
    const data = await api(`/approvals/${approvalId}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_analytics",
  "Get post performance analytics — impressions, likes, comments, shares.",
  {
    platform: z.string().optional().describe("Filter by platform"),
    startDate: z.string().optional().describe("Start date (ISO 8601)"),
    endDate: z.string().optional().describe("End date (ISO 8601)"),
    page: z.number().optional().describe("Page number"),
    limit: z.number().optional().describe("Results per page"),
  },
  async ({ platform, startDate, endDate, page, limit }) => {
    const params = new URLSearchParams();
    if (platform) params.set("platform", platform);
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (page) params.set("page", String(page));
    if (limit) params.set("limit", String(limit));

    const data = await api(`/analytics?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "upload_media",
  "Get a presigned URL to upload an image or video for use in posts.",
  {
    filename: z.string().describe("File name (e.g. 'photo.jpg')"),
    contentType: z.string().describe("MIME type (e.g. 'image/jpeg', 'video/mp4')"),
    size: z.number().describe("File size in bytes"),
  },
  async ({ filename, contentType, size }) => {
    const data = await api("/media/upload-url", {
      method: "POST",
      body: JSON.stringify({ filename, contentType, size }),
    });
    return { content: [{ type: "text" as const, text: `Upload URL generated. Upload your file with PUT to the URL below, then use the key/publicUrl in create_post media array.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "repurpose_content",
  "Save AI-repurposed content as draft posts. Provide an array of posts with content and target connections.",
  {
    posts: z.array(z.object({
      content: z.string().describe("Repurposed post content"),
      connectionIds: z.array(z.string()).describe("Connection IDs to target"),
    })).describe("Array of repurposed posts to save as drafts"),
  },
  async ({ posts }) => {
    const data = await api("/repurpose", {
      method: "POST",
      body: JSON.stringify({ posts }),
    });
    return { content: [{ type: "text" as const, text: `${data.data.savedCount} draft posts saved.\n\n${JSON.stringify(data.data.posts, null, 2)}` }] };
  }
);

server.tool(
  "list_video_templates",
  "List available video templates (quotes, hooks, listicles, stories, product showcases, testimonials, promos). Each template describes its editable fields — use them with create_video.",
  {
    category: z.string().optional().describe("Filter by template category"),
  },
  async ({ category }) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    const data = await api(`/videos/templates?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "create_video",
  "Submit a video render job from a template. Returns a render ID — poll get_video_status until status is 'completed', then use the returned video URL as post media.",
  {
    templateId: z.string().describe("Template ID from list_video_templates"),
    fields: z.record(z.string(), z.any()).describe("Field values for the template, e.g. { quoteText: '...', backgroundColor: '#111' }. Field names come from the template definition."),
    aspectRatio: z.string().optional().describe("Override aspect ratio (e.g. '9:16', '1:1'). Defaults to the template's ratio."),
  },
  async ({ templateId, fields, aspectRatio }) => {
    const body: any = { templateId, fields };
    if (aspectRatio) body.aspectRatio = aspectRatio;
    const data = await api("/videos/render", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Render submitted. Poll get_video_status with this ID until completed.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "get_video_status",
  "Check the status of a video render job. Completed renders include presigned download URLs for the video and thumbnail (valid ~1 hour).",
  {
    id: z.string().describe("Render ID from create_video"),
  },
  async ({ id }) => {
    const data = await api(`/videos/render/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "generate_carousel",
  "Generate carousel slide TEXT (title/content/quote/CTA) from long-form content. Then call render_carousel to turn the slides into branded PNG images in the media library.",
  {
    content: z.string().describe("Source content to decompose into slides (20–10,000 chars)"),
    platform: z.enum(["instagram", "linkedin"]).optional().describe("Platform hint for tone/length (default instagram)"),
    maxSlides: z.number().optional().describe("Max slides, 3–10 (default 5)"),
    style: z.enum(["minimal", "bold", "professional", "playful"]).optional().describe("Copywriting tone hint"),
    brandColors: z.object({
      primary: z.string().optional(),
      secondary: z.string().optional(),
    }).optional().describe("Brand colors as hex strings"),
  },
  async ({ content, platform, maxSlides, style, brandColors }) => {
    const body: any = { content };
    if (platform) body.platform = platform;
    if (maxSlides) body.maxSlides = maxSlides;
    if (style) body.style = style;
    if (brandColors) body.brandColors = brandColors;
    const data = await api("/carousels/generate", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Slides generated. Pass them to render_carousel (pick a family/palette via list_carousel_styles) to produce images.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "list_carousel_styles",
  "List the carousel design system: template families (with content-variant layouts), the 40-palette library (with resolved colors), output formats, font pairings, and slide caps. Use the ids with render_carousel.",
  {},
  async () => {
    const data = await api("/carousels/options");
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "render_carousel",
  "Render carousel slides into branded PNG images (server-side, pixel-perfect) saved to the media library. Returns a render ID — poll get_carousel_render until 'completed'. Slide 1 uses the family's cover layout, the last slide its CTA layout, middle slides cycle content variants.",
  {
    slides: z.array(z.object({
      headline: z.string().describe("Slide headline (≤500 chars)"),
      body: z.string().describe("Slide body (≤2000 chars; may be empty)"),
      type: z.enum(["title", "content", "quote", "cta"]).describe("Slide role — 'title' pins the cover layout, 'cta' the CTA layout"),
      imageUrl: z.string().optional().describe("https image for this slide (used by photo layouts)"),
    })).min(2).max(10).describe("2–10 slides, in order (from generate_carousel or hand-written)"),
    family: z.string().describe("Template family id from list_carousel_styles (e.g. 'bold-announcement', 'tips-listicle', 'photo-story')"),
    format: z.enum(["portrait", "square", "square-lg", "story"]).optional().describe("Output size: portrait 1080×1350 (default, IG/FB), square 1080×1080, square-lg 1200×1200 (LinkedIn), story 1080×1920 (TikTok photo mode)"),
    paletteId: z.string().optional().describe("Palette id from list_carousel_styles (defaults to the family's suggested palette)"),
    brandKitId: z.string().optional().describe("Brand kit id from list_brand_kits — applies its palette, fonts, logo, and handle (explicit values below still win; narrow with brandParts)"),
    brandParts: z.object({
      colors: z.boolean().optional().describe("Apply the kit's palette (default true)"),
      fonts: z.boolean().optional().describe("Apply the kit's font pairing (default true)"),
      logo: z.boolean().optional().describe("Apply the kit's logo (default true)"),
      identity: z.boolean().optional().describe("Apply the kit's @handle / brand name (default true)"),
    }).optional().describe("With brandKitId: which kit parts to apply. Omitted object/keys default to true (apply everything) — set a key to false to skip that part"),
    fontPairingId: z.enum(["impact", "friendly", "editorial", "clean", "geometric"]).optional().describe("Font pairing (defaults to the family's)"),
    fontSize: z.enum(["small", "medium", "large"]).optional().describe("Type scale (default medium)"),
    numbering: z.boolean().optional().describe("Add an 'i/N' position chip to each slide"),
    seamless: z.boolean().optional().describe("One wide mesh background sliced across all slides — swiping reveals a continuous panorama"),
    seamlessSeed: z.number().optional().describe("Seed for the seamless mesh (same seed = same background)"),
    handle: z.string().optional().describe("'@handle' meta text worked into covers and CTAs"),
    logoUrl: z.string().optional().describe("https logo placed bottom-left on every slide"),
    defaultImageUrl: z.string().optional().describe("Fallback https image for photo layouts when a slide has none"),
  },
  async ({ slides, family, format, paletteId, brandKitId, brandParts, fontPairingId, fontSize, numbering, seamless, seamlessSeed, handle, logoUrl, defaultImageUrl }) => {
    const settings: any = {
      version: 2,
      format: format ?? "portrait",
      family,
      fontSize: fontSize ?? "medium",
    };
    if (paletteId) settings.paletteId = paletteId;
    if (brandKitId) settings.brandKitId = brandKitId;
    if (brandKitId && brandParts) settings.brandParts = brandParts;
    if (fontPairingId) settings.fontPairingId = fontPairingId;
    if (numbering !== undefined) settings.numbering = numbering;
    if (seamless) settings.seamless = { enabled: true, ...(seamlessSeed !== undefined ? { seed: seamlessSeed } : {}) };
    if (handle) settings.handle = handle;
    if (logoUrl) settings.logoUrl = logoUrl;
    if (defaultImageUrl) settings.defaultImageUrl = defaultImageUrl;
    const body = {
      slides: slides.map((s, i) => ({ order: i, ...s })),
      settings,
    };
    const data = await api("/carousels/render", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Render submitted (~1-3s per slide). Poll get_carousel_render with this ID until completed.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "get_carousel_render",
  "Check a carousel render job. When completed, `assets` are full media attachments (id/type/url/key/filename/mimeType/size, in slide order) — pass them straight into create_post's `media` array to draft or schedule the carousel post.",
  {
    id: z.string().describe("Render ID from render_carousel"),
  },
  async ({ id }) => {
    const data = await api(`/carousels/render/${id}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "list_brand_kits",
  "List saved brand kits (palette, font pairing, logo, handle). Use a kit's id as render_carousel's brandKitId for one-call branded output.",
  {},
  async () => {
    const data = await api("/brand-kits");
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "list_content_sources",
  "List connected content sources (WordPress sites, RSS feeds) used to import content for repurposing.",
  {},
  async () => {
    const data = await api("/content-sources");
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "add_content_source",
  "Connect a WordPress site or RSS feed as a content source. Imported posts can then be repurposed into social content.",
  {
    type: z.enum(["wordpress", "rss"]).describe("Source type"),
    name: z.string().describe("Display name for the source"),
    url: z.string().describe("Site URL (WordPress base URL or RSS feed URL)"),
    apiKey: z.string().optional().describe("Optional API key for protected WordPress sites"),
    autoImport: z.boolean().optional().describe("Automatically import new content on the sync schedule"),
    importFrequency: z.enum(["daily", "weekly"]).optional().describe("Auto-import frequency (default weekly)"),
  },
  async ({ type, name, url, apiKey, autoImport, importFrequency }) => {
    const body: any = { type, name, url };
    if (apiKey) body.apiKey = apiKey;
    if (autoImport !== undefined || importFrequency) {
      body.settings = { autoImport: autoImport ?? false, importFrequency: importFrequency ?? "weekly" };
    }
    const data = await api("/content-sources", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: `Content source connected.\n\n${JSON.stringify(data.data, null, 2)}` }] };
  }
);

server.tool(
  "delete_content_source",
  "Remove a content source.",
  {
    id: z.string().describe("Content source ID"),
  },
  async ({ id }) => {
    await api(`/content-sources/${id}`, { method: "DELETE" });
    return { content: [{ type: "text" as const, text: `Content source ${id} deleted.` }] };
  }
);

server.tool(
  "fetch_source_content",
  "Import the latest content from a source (e.g. new WordPress posts) right now, then list it with list_imported_content.",
  {
    id: z.string().describe("Content source ID"),
  },
  async ({ id }) => {
    const data = await api(`/content-sources/${id}/fetch`, { method: "POST" });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "list_imported_content",
  "List content already imported from a source — useful as input for repurpose_content or create_post.",
  {
    id: z.string().describe("Content source ID"),
  },
  async ({ id }) => {
    const data = await api(`/content-sources/${id}/content`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_revenue_overview",
  "Get revenue analytics: totals and trend vs the previous period, recent transactions, and MRR metrics from connected providers (Stripe / RevenueCat / Shopify). Read-only.",
  {
    days: z.number().optional().describe("Lookback window in days (default 30)"),
    appId: z.string().optional().describe("Scope to a specific app's revenue connections"),
    includeTransactions: z.boolean().optional().describe("Also fetch recent Stripe charges (default false)"),
    includeMrr: z.boolean().optional().describe("Also fetch Stripe/RevenueCat MRR metrics (default false)"),
  },
  async ({ days, appId, includeTransactions, includeMrr }) => {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    if (appId) params.set("appId", appId);

    const overview = await api(`/revenue/overview?${params}`);
    const result: any = { overview: overview.data };

    if (includeTransactions) {
      const txParams = new URLSearchParams();
      if (appId) txParams.set("appId", appId);
      const tx = await api(`/revenue/transactions?${txParams}`).catch((e) => ({ data: { error: e.message } }));
      result.transactions = tx.data;
    }
    if (includeMrr) {
      const mrrParams = new URLSearchParams();
      if (appId) mrrParams.set("appId", appId);
      const [stripe, rc] = await Promise.all([
        api(`/revenue/stripe-metrics?${mrrParams}`).catch((e) => ({ data: { error: e.message } })),
        api(`/revenue/rc-metrics?${mrrParams}`).catch((e) => ({ data: { error: e.message } })),
      ]);
      result.mrr = { stripe: stripe.data, revenuecat: rc.data };
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "generate_image",
  "Generate an image with AI (DALL-E) for use in posts. Costs 1 AI credit. Returns the image URL — pass it through upload_media/create_post media flow.",
  {
    prompt: z.string().describe("What to generate (≤4000 chars)"),
    width: z.number().optional(),
    height: z.number().optional(),
    style: z.string().optional().describe("Style hint (e.g. 'photorealistic', 'illustration')"),
  },
  async ({ prompt, width, height, style }) => {
    const body: any = { prompt };
    if (width) body.width = width;
    if (height) body.height = height;
    if (style) body.style = style;
    const data = await api("/images/generate", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_brand_voices",
  "List the user's brand voices (tone-of-voice profiles analyzed from their content).",
  {},
  async () => {
    const data = await api("/brand-voice");
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_brand_voice_prompt",
  "Get the ready-to-use system prompt for a brand voice — apply it when writing posts so the content matches the user's tone.",
  {
    id: z.string().describe("Brand voice ID (see get_brand_voices)"),
  },
  async ({ id }) => {
    const data = await api(`/brand-voice/${id}/prompt`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_best_times",
  "Get the best times to post per platform, based on the user's engagement history. Use before picking scheduledFor in create_post.",
  {
    platform: z.string().optional().describe("Limit to one platform (e.g. 'instagram')"),
  },
  async ({ platform }) => {
    const params = new URLSearchParams();
    if (platform) params.set("platform", platform);
    const data = await api(`/smart-schedule/best-times?${params}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "suggest_schedule",
  "Ask the smart scheduler to spread N posts across a date range at optimal times. Returns concrete timestamps for create_post.",
  {
    numberOfPosts: z.number().describe("How many posts to schedule"),
    platforms: z.array(z.string()).describe("Target platforms (e.g. ['instagram','linkedin'])"),
    startDate: z.string().describe("Range start (ISO 8601)"),
    endDate: z.string().describe("Range end (ISO 8601)"),
  },
  async ({ numberOfPosts, platforms, startDate, endDate }) => {
    const data = await api("/smart-schedule/suggest", {
      method: "POST",
      body: JSON.stringify({ numberOfPosts, platforms, startDate, endDate }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "get_posting_schedule",
  "Read the weekly posting queue schedule: the global schedule plus any per-group overrides. Slots are {day: 1-7 (Mon=1..Sun=7), time: 'HH:MM' 24h} in the user's timezone. Groups without an override inherit the global schedule. Needs the schedule:read permission.",
  {},
  async () => {
    const data = await api("/posting-queue/queues");
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);

server.tool(
  "set_posting_schedule",
  "Replace the weekly posting queue slots for the global schedule or one account group (Pro feature; needs the schedule:write permission). Pass the FULL desired slot list — it replaces the existing one. An empty array on a group removes its override so it inherits the global schedule again.",
  {
    groupId: z
      .string()
      .optional()
      .describe("Account group id (from list_account_groups); omit for the global schedule"),
    slots: z
      .array(
        z.object({
          day: z.number().int().min(1).max(7).describe("ISO weekday: 1=Monday .. 7=Sunday"),
          time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .describe("24h time 'HH:MM' in the user's timezone, e.g. '09:30'"),
        })
      )
      .describe("The complete weekly slot list to store"),
  },
  async ({ groupId, slots }) => {
    const data = await api(`/posting-queue/queues/${encodeURIComponent(groupId ?? "global")}`, {
      method: "PUT",
      body: JSON.stringify({ slots }),
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(data.data, null, 2) }] };
  }
);
}

// ─── Start ───

async function startStdio(): Promise<void> {
  if (!ENV_API_KEY) {
    console.error("PLANPOST_API_KEY environment variable is required");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Remote/streamable-HTTP mode: `planpost-mcp --http [--port 3020]`.
 *
 * Stateless — every POST /mcp builds a fresh server + transport, and the
 * caller's credential is scoped to that request via AsyncLocalStorage. That
 * makes one hosted instance safely multi-tenant.
 *
 * Two ways to authenticate:
 *  - `Authorization: Bearer pk_...` — a PlanPost API key, always accepted
 *    (e.g. `claude mcp add --transport http planpost https://host/mcp
 *    --header "Authorization: Bearer pk_..."`).
 *  - OAuth, when configured (see oauth.ts): a request without credentials is
 *    answered 401 with a pointer to the protected-resource metadata, the
 *    client signs the user in at planpo.st, and comes back with a token.
 */
async function startHttp(port: number, host: string): Promise<void> {
  const oauth = loadOAuthSettings(process.env, BASE_URL);
  const verifier = oauth ? new AccessTokenVerifier(oauth) : null;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // An API host must never rank: Google indexed the bare /mcp 405 JSON as a
    // page under the brand. The header, not robots.txt, is the fix on purpose:
    // a crawler has to be able to fetch the URL to see the noindex, so
    // robots.txt below allows crawling and this header does the de-indexing.
    res.setHeader("X-Robots-Tag", "noindex, nofollow");

    const fail = (status: number, message: string, headers: Record<string, string> = {}) => {
      // charset is load-bearing: without it, any non-ASCII byte in a message
      // renders as mojibake in browsers that assume latin-1 for JSON.
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname === "/robots.txt") {
        // Allow crawling so the X-Robots-Tag noindex is actually seen.
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("User-agent: *\nDisallow:\n");
        return;
      }
      if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
        // A human (or crawler) landing on the bare host gets the docs page
        // instead of a JSON error.
        res.writeHead(302, { Location: "https://planpo.st/mcp" });
        res.end();
        return;
      }
      if (url.pathname === "/.well-known/openai-apps-challenge" && process.env.OPENAI_APPS_CHALLENGE) {
        // Domain verification for the ChatGPT plugin directory: OpenAI issues
        // a token at submission time and fetches it from here as plain text.
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(process.env.OPENAI_APPS_CHALLENGE);
        return;
      }
      if (oauth && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        // Served at both the path-suffixed and the root well-known URL:
        // clients try them in that order when the 401 challenge is missing.
        const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length);
        if (suffix !== "" && suffix !== oauth.resourceUrl.pathname) {
          return fail(404, "Not found. The MCP endpoint is /mcp");
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(JSON.stringify(protectedResourceMetadata(oauth)));
        return;
      }
      if (url.pathname !== "/mcp") return fail(404, "Not found. The MCP endpoint is /mcp");
      if (req.method !== "POST") {
        // Stateless mode: no SSE resumption stream, no sessions to delete.
        return fail(
          405,
          "Method not allowed. This stateless transport accepts POST only; setup guide at https://planpo.st/mcp",
        );
      }

      const auth = req.headers.authorization || "";
      const bearer = /^Bearer /i.test(auth) ? auth.slice(7).trim() : "";
      let credential: Credential;
      if (bearer.startsWith("pk_")) {
        credential = { kind: "key", key: bearer };
      } else if (!oauth || !verifier) {
        return fail(401, "Provide your PlanPost API key: Authorization: Bearer pk_...");
      } else if (!bearer) {
        // The challenge is what starts the OAuth flow in the client.
        return fail(
          401,
          "Sign in to PlanPost to use this server, or send an API key: Authorization: Bearer pk_...",
          { "WWW-Authenticate": bearerChallenge(oauth) },
        );
      } else {
        try {
          const authInfo = await verifier.verify(bearer);
          // The transport hands this to tool handlers as `extra.authInfo`.
          (req as IncomingMessage & { auth?: unknown }).auth = authInfo;
          credential = {
            kind: "grant",
            grantId: String(authInfo.extra?.grantId),
            serviceSecret: oauth.serviceSecret,
          };
        } catch (err) {
          if (err instanceof InvalidTokenError) {
            return fail(401, err.message, {
              "WWW-Authenticate": bearerChallenge(oauth, err.message),
            });
          }
          if (err instanceof IntrospectionUnavailableError) {
            // Not the client's fault: a 401 here would make it throw away a
            // good token and send the user through sign-in again.
            console.error("[planpost-mcp]", err.message);
            return fail(503, "PlanPost sign-in is temporarily unavailable. Try again shortly.");
          }
          throw err;
        }
      }

      const body = await readBody(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await requestCredential.run(credential, () => transport.handleRequest(req, res, body));
    } catch (err) {
      console.error("[planpost-mcp] request error:", err);
      if (!res.headersSent) fail(500, "Internal error");
    }
  });

  httpServer.listen(port, host, () => {
    console.log(
      `planpost-mcp listening on http://${host}:${port}/mcp (streamable HTTP, stateless; ` +
        (oauth ? `OAuth via ${oauth.issuer} + API keys)` : "API keys only)"),
    );
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--http")) {
    const portArg = args[args.indexOf("--port") + 1];
    const port = Number(portArg) || Number(process.env.PORT) || 3020;
    // Defaults to all interfaces so `--http` works in a container or on a LAN
    // without extra flags. Behind a reverse proxy set HOST=127.0.0.1 so the
    // port isn't reachable except through the proxy.
    const hostArg = args.includes("--host") ? args[args.indexOf("--host") + 1] : undefined;
    const host = hostArg || process.env.HOST || "0.0.0.0";
    await startHttp(port, host);
    return;
  }
  await startStdio();
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
