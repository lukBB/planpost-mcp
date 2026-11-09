# PlanPost

PlanPost is the agentic social scheduler with revenue attribution. This
extension connects Gemini CLI to the user's PlanPost account through the
`planpost` MCP server (sign-in happens in the browser the first time; run
`/mcp auth planpost` if it does not start by itself).

How to work with it:

- Start with `list_connections` or `list_account_groups`. Every post targets
  connection IDs; never guess them.
- Draft first. `create_post` without `scheduledFor` saves a draft; add
  `scheduledFor` (ISO 8601, with the user's timezone) to schedule. Use
  `preview_post` to see what each network will receive.
- Posts created through this connection may be held for the user's approval
  (status `needs_approval`). That is expected: tell the user it is waiting in
  their Approvals inbox instead of retrying.
- X (Twitter) posts must not contain links. Put a link-free version in
  `platformContent.twitter`.
- A failed or partly published post explains itself: read
  `platformResults[].error` and `.fix` from `get_post` before `retry_failed`.
- Connecting a new social account needs the user: `get_connection_link`
  returns a URL for them to open.
- `get_revenue_overview` and `get_analytics` answer "what worked" questions.

Full instructions: `skills/planpost/SKILL.md`.
