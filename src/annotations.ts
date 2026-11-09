import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool annotations, required by the Claude and ChatGPT directories: every
 * tool needs a human title and explicit readOnly / destructive / openWorld
 * hints so the client knows which calls to confirm with the user.
 *
 *  - read:    only reads from PlanPost.
 *  - write:   creates or changes something inside PlanPost, reversibly.
 *  - destroy: deletes, overwrites, or sends something that cannot be recalled.
 *  - `world`: the effect can reach outside PlanPost — a post going out on a
 *             social network, or a third-party URL being fetched.
 *
 * Every registered tool must have an entry; `npm test` fails otherwise.
 */
type Kind = "read" | "write" | "destroy";

const TOOLS: Record<string, [title: string, kind: Kind, world?: "world"]> = {
  list_posts: ["List posts", "read"],
  get_post: ["Get a post", "read"],
  // Can publish immediately, and a published post cannot be recalled.
  create_post: ["Create, schedule or publish a post", "destroy", "world"],
  preview_post: ["Preview a post per platform", "read"],
  bulk_create_posts: ["Create several posts", "destroy", "world"],
  list_campaigns: ["List campaigns", "read"],
  delete_posts: ["Delete several posts", "destroy"],
  list_media: ["List media library", "read"],
  update_post: ["Edit a post", "destroy", "world"],
  delete_post: ["Delete a post", "destroy"],
  retry_failed: ["Retry failed platforms", "destroy", "world"],
  get_delivery_report: ["Get delivery report", "read"],
  publish_post: ["Publish a post now", "destroy", "world"],
  list_connections: ["List connected social accounts", "read"],
  list_account_groups: ["List account groups", "read"],
  get_account_group: ["Get an account group", "read"],
  create_account_group: ["Create an account group", "write"],
  update_account_group: ["Edit an account group", "destroy"],
  delete_account_group: ["Delete an account group", "destroy"],
  add_connections_to_group: ["Add accounts to a group", "write"],
  remove_connections_from_group: ["Remove accounts from a group", "destroy"],
  get_connection_link: ["Get a link to connect an account", "read"],
  submit_for_approval: ["Submit a post for approval", "write"],
  list_pending_approvals: ["List pending approvals", "read"],
  get_approval_status: ["Get approval status", "read"],
  get_analytics: ["Get post analytics", "read"],
  upload_media: ["Get a media upload URL", "write"],
  repurpose_content: ["Repurpose content with AI", "write"],
  list_video_templates: ["List video templates", "read"],
  create_video: ["Render a video", "write"],
  get_video_status: ["Get video render status", "read"],
  generate_carousel: ["Draft carousel slides", "write"],
  list_carousel_styles: ["List carousel styles", "read"],
  render_carousel: ["Render a carousel", "write"],
  get_carousel_render: ["Get carousel render status", "read"],
  list_brand_kits: ["List brand kits", "read"],
  list_content_sources: ["List content sources", "read"],
  add_content_source: ["Add a content source", "write", "world"],
  delete_content_source: ["Delete a content source", "destroy"],
  fetch_source_content: ["Sync a content source", "write", "world"],
  list_imported_content: ["List imported content", "read"],
  get_revenue_overview: ["Get revenue overview", "read"],
  generate_image: ["Generate an image", "write"],
  get_brand_voices: ["List brand voices", "read"],
  get_brand_voice_prompt: ["Get a brand voice prompt", "read"],
  get_best_times: ["Get best times to post", "read"],
  suggest_schedule: ["Suggest a schedule", "read"],
  get_posting_schedule: ["Get posting schedule", "read"],
  set_posting_schedule: ["Replace posting schedule", "destroy"],
};

export const ANNOTATED_TOOLS = Object.keys(TOOLS);

export function annotationsFor(name: string): ToolAnnotations {
  const entry = TOOLS[name];
  if (!entry) throw new Error(`Tool "${name}" has no entry in annotations.ts`);
  const [title, kind, world] = entry;
  return {
    title,
    readOnlyHint: kind === "read",
    destructiveHint: kind === "destroy",
    idempotentHint: kind === "read",
    openWorldHint: world === "world",
  };
}
