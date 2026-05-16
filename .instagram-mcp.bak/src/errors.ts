/**
 * Typed errors for the Instagram MCP server.
 *
 * Every error message includes:
 *   1. what failed in plain English
 *   2. the Meta error code if present
 *   3. a specific next step the user/agent can take
 *
 * These bubble up through MCP as tool errors. Actionable messages = fewer wasted agent turns.
 */

export class InstagramMcpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly subcode?: number,
  ) {
    super(message);
    this.name = "InstagramMcpError";
  }
}

export class NotConnectedError extends InstagramMcpError {
  constructor() {
    super(
      "Not connected to Instagram. The agent should call instagram_connect to start the OAuth login flow.",
    );
    this.name = "NotConnectedError";
  }
}

export class FeatureDisabledError extends InstagramMcpError {
  constructor(flag: string, scope: string) {
    super(
      `This tool is not available in the current build of instagram-mcp-buddy. The ${flag} feature is disabled — it will be enabled in a future npm release once Meta App Review approves the ${scope} permission. Update via 'npx -y instagram-mcp-buddy@latest'.`,
    );
    this.name = "FeatureDisabledError";
  }
}

export class AuthError extends InstagramMcpError {
  constructor(code = 190, subcode?: number) {
    super(
      `Instagram access token is invalid or expired (code ${code}). ` +
        `The token may have been revoked from your Instagram settings, or this refresh attempt failed. ` +
        `Call instagram_logout then instagram_connect to log back in.`,
      code,
      subcode,
    );
    this.name = "AuthError";
  }
}

export class PermissionError extends InstagramMcpError {
  constructor(code: number, message: string) {
    super(
      `Permission denied (code ${code}): ${message}. ` +
        `The signed-in account did not grant the scope this tool needs. Call instagram_status to ` +
        `see which scopes are currently granted, then re-run instagram_connect if you need to add more.`,
      code,
    );
    this.name = "PermissionError";
  }
}

export class RateLimitError extends InstagramMcpError {
  constructor(code: number, usagePercent?: number) {
    super(
      `Instagram API rate limit reached (code ${code})` +
        (usagePercent !== undefined ? ` at ${usagePercent}% usage` : "") +
        `. Meta resets Business Use Case Usage hourly. Wait at least 1 hour before retrying, ` +
        `or reduce request frequency. The server already retried automatically.`,
      code,
    );
    this.name = "RateLimitError";
  }
}

export class MediaIneligibleError extends InstagramMcpError {
  constructor(reason: string) {
    super(
      `Instagram rejected the media: ${reason}. ` +
        `Check the format requirements: ` +
        `Images must be JPEG/PNG, ≤8MB, aspect ratio between 4:5 and 1.91:1. ` +
        `Reels must be MP4, ≤100MB, ≤90s, H.264 video + AAC audio. ` +
        `All media URLs must be publicly accessible HTTPS.`,
    );
    this.name = "MediaIneligibleError";
  }
}

export class ContainerError extends InstagramMcpError {
  constructor(containerId: string, statusCode: string, detail?: string) {
    super(
      `Media container ${containerId} entered status ${statusCode}${detail ? `: ${detail}` : ""}. ` +
        `This usually means Instagram could not fetch or process the source media. ` +
        `Verify the media URL is public HTTPS, the file format is supported, and try again with a fresh container.`,
    );
    this.name = "ContainerError";
  }
}

export class ContainerTimeout extends InstagramMcpError {
  constructor(containerId: string, elapsedMs: number) {
    super(
      `Media container ${containerId} did not finish processing within ${elapsedMs}ms. ` +
        `Reels can take several minutes to process. Increase IG_REEL_TIMEOUT_MS if this happens often, ` +
        `or use the lower-level instagram_create_container + instagram_get_container_status tools to poll manually.`,
    );
    this.name = "ContainerTimeout";
  }
}

export class NotFoundError extends InstagramMcpError {
  constructor(resource: string) {
    super(
      `Instagram returned 404 for ${resource}. ` +
        `The resource may have been deleted, or you may not have permission to access it. ` +
        `For comments/replies, also verify the id format is correct.`,
      404,
    );
    this.name = "NotFoundError";
  }
}

export class GraphApiError extends InstagramMcpError {
  constructor(message: string, code?: number, subcode?: number) {
    super(
      `Instagram Graph API error${code ? ` (code ${code}${subcode ? `, subcode ${subcode}` : ""})` : ""}: ${message}.`,
      code,
      subcode,
    );
    this.name = "GraphApiError";
  }
}

/**
 * Maps a Meta API error payload to one of our typed errors.
 * Meta error response shape: { error: { code, error_subcode, message, type, ... } }
 */
export function mapGraphError(payload: unknown): InstagramMcpError {
  if (typeof payload !== "object" || payload === null) {
    return new GraphApiError("Unknown error (non-object response)");
  }
  const errorObj =
    "error" in payload && typeof (payload as { error: unknown }).error === "object"
      ? ((payload as { error: Record<string, unknown> }).error)
      : (payload as Record<string, unknown>);
  const code = typeof errorObj.code === "number" ? errorObj.code : undefined;
  const subcode =
    typeof errorObj.error_subcode === "number" ? errorObj.error_subcode : undefined;
  const message = typeof errorObj.message === "string" ? errorObj.message : "Unknown error";

  if (code === 190) return new AuthError(code, subcode);
  if (code === 10 || code === 200 || code === 299) return new PermissionError(code, message);
  if (code === 4 || code === 17 || code === 32 || code === 613) return new RateLimitError(code);
  if (code === 2207026 || subcode === 2207026)
    return new MediaIneligibleError(message);
  if (code === 803 || code === 100) return new NotFoundError(message);
  return new GraphApiError(message, code, subcode);
}
