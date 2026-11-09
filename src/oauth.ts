import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

/**
 * OAuth for the hosted (streamable HTTP) server, per the MCP authorization
 * spec. This process is the OAuth *resource server*; the PlanPost API is the
 * *authorization server* (it runs /oauth/authorize, /token, /register).
 *
 * What happens here:
 *  - `/.well-known/oauth-protected-resource[/mcp]` tells clients where to
 *    sign in (RFC 9728).
 *  - A request with no or a bad token gets `401` + `WWW-Authenticate: Bearer
 *    resource_metadata="…"`, which is how a client discovers that document.
 *  - A `ppo_at_…` access token is validated by introspection (RFC 7662) and
 *    must have been issued for THIS server (`aud`), per RFC 8707.
 *
 * The access token is never forwarded to the API ("token passthrough" is
 * forbidden by the spec). Tool calls go upstream with this server's own
 * service secret plus the id of the grant they act for; see `Credential`.
 *
 * OAuth is on only when all three env vars are set, so a self-hosted
 * `planpost-mcp --http` keeps working with API keys alone.
 */

export interface OAuthSettings {
  /** Public URL of this server's MCP endpoint, e.g. https://mcp.planpo.st/mcp */
  resourceUrl: URL;
  /** Authorization server issuer, e.g. https://api.planpo.st */
  issuer: string;
  /** Where to reach the API for introspection (usually the same host). */
  apiUrl: string;
  /** Shared with the API (its MCP_SERVICE_SECRET). */
  serviceSecret: string;
}

export function loadOAuthSettings(
  env: NodeJS.ProcessEnv,
  apiUrl: string
): OAuthSettings | null {
  const publicUrl = env.PLANPOST_MCP_PUBLIC_URL;
  const serviceSecret = env.PLANPOST_MCP_SERVICE_SECRET;
  if (!publicUrl || !serviceSecret) return null;
  if (serviceSecret.length < 32) {
    throw new Error("PLANPOST_MCP_SERVICE_SECRET must be at least 32 characters");
  }
  return {
    resourceUrl: new URL(publicUrl),
    issuer: (env.PLANPOST_OAUTH_ISSUER || apiUrl).replace(/\/+$/, ""),
    apiUrl: apiUrl.replace(/\/+$/, ""),
    serviceSecret,
  };
}

/**
 * How a request authenticates upstream: a user's own API key, or an OAuth
 * grant this server vouches for with its service secret.
 */
export type Credential =
  | { kind: "key"; key: string }
  | { kind: "grant"; grantId: string; serviceSecret: string };

export function upstreamHeaders(credential: Credential): Record<string, string> {
  return credential.kind === "key"
    ? { Authorization: `Bearer ${credential.key}` }
    : {
        "X-Planpost-Mcp-Secret": credential.serviceSecret,
        "X-Planpost-OAuth-Grant": credential.grantId,
      };
}

/** RFC 9728 §3.1: the well-known path carries the resource's own path as a suffix. */
export function resourceMetadataUrl(settings: OAuthSettings): string {
  const { resourceUrl } = settings;
  const suffix = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname;
  return new URL(`/.well-known/oauth-protected-resource${suffix}`, resourceUrl).href;
}

export function protectedResourceMetadata(settings: OAuthSettings): OAuthProtectedResourceMetadata {
  return {
    resource: settings.resourceUrl.href,
    authorization_servers: [settings.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "PlanPost",
    resource_documentation: "https://planpo.st/docs/agents",
  };
}

/**
 * The `WWW-Authenticate` value for a 401. No `scope`: the client then asks
 * for the authorization server's `scopes_supported`, and the user narrows
 * nothing by accident.
 */
export function bearerChallenge(settings: OAuthSettings, invalidTokenReason?: string): string {
  const parts = invalidTokenReason
    ? [`error="invalid_token"`, `error_description="${invalidTokenReason.replace(/["\\]/g, "")}"`]
    : [];
  parts.push(`resource_metadata="${resourceMetadataUrl(settings)}"`);
  return `Bearer ${parts.join(", ")}`;
}

/** The token is not valid here: answer 401 with a challenge. */
export class InvalidTokenError extends Error {}
/** The authorization server could not be asked: answer 503, not 401. */
export class IntrospectionUnavailableError extends Error {}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 2_000;

export class AccessTokenVerifier {
  private cache = new Map<string, { info: AuthInfo; until: number }>();

  constructor(
    private readonly settings: OAuthSettings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Introspects the token and checks it was minted for this server. Results
   * are cached briefly; revocation still bites at once, because the API looks
   * the grant up again on every tool call.
   */
  async verify(token: string): Promise<AuthInfo> {
    const cacheKey = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > now && (hit.info.expiresAt ?? 0) * 1000 > now) return hit.info;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.settings.apiUrl}/oauth/introspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${this.settings.serviceSecret}`,
        },
        body: new URLSearchParams({ token }).toString(),
      });
    } catch (err) {
      throw new IntrospectionUnavailableError(`introspection request failed: ${String(err)}`);
    }
    if (!response.ok) {
      throw new IntrospectionUnavailableError(`introspection returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      active?: boolean;
      scope?: string;
      client_id?: string;
      aud?: string;
      exp?: number;
      grant_id?: string;
    };

    if (!data.active || !data.grant_id || typeof data.exp !== "number") {
      this.cache.delete(cacheKey);
      throw new InvalidTokenError("The access token is invalid, expired or revoked");
    }
    if (
      !data.aud ||
      !checkResourceAllowed({
        requestedResource: data.aud,
        configuredResource: this.settings.resourceUrl,
      })
    ) {
      throw new InvalidTokenError("The access token was not issued for this server");
    }

    const info: AuthInfo = {
      token,
      clientId: data.client_id ?? "",
      scopes: data.scope ? data.scope.split(" ") : [],
      expiresAt: data.exp,
      resource: this.settings.resourceUrl,
      extra: { grantId: data.grant_id },
    };
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(cacheKey, { info, until: now + CACHE_TTL_MS });
    return info;
  }
}
