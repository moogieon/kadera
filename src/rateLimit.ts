import type { NextFunction, Request, RequestHandler, Response } from "express";

interface RateLimitOptions {
  /** Per-IP budget for the browser API, where one address really is one user. */
  maxRequests: number;
  /**
   * Shared budget for MCP tool calls. Kakao Tools proxies every user through a
   * small set of egress addresses, so a per-IP cap here does not throttle a
   * heavy user, it throttles the entire product. Sized as an overload guard.
   */
  mcpMaxRequests: number;
  windowMs: number;
  now?: () => number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

/** Every MCP caller shares one bucket, so the key is a constant rather than an address. */
const mcpBucketKey = "mcp";

export function createRequestRateLimiter(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  const now = options.now ?? Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    const scope = rateLimitScope(req.method, req.path, req.body);
    if (!scope) {
      next();
      return;
    }

    const timestamp = now();
    const key = scope === "mcp" ? mcpBucketKey : `api:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const limit = scope === "mcp" ? options.mcpMaxRequests : options.maxRequests;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) {
      buckets.set(key, { count: 1, resetAt: timestamp + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - timestamp) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: `요청이 많습니다. ${retryAfter}초 후 다시 시도해주세요.` });
      return;
    }
    next();
  };
}

export function rateLimitScope(method: string, path: string, body: unknown): "mcp" | "api" | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  if (path === "/mcp") return containsMcpToolCall(body) ? "mcp" : undefined;
  return path.startsWith("/api/") ? "api" : undefined;
}

export function shouldRateLimitRequest(method: string, path: string, body: unknown): boolean {
  return rateLimitScope(method, path, body) !== undefined;
}

function containsMcpToolCall(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(containsMcpToolCall);
  if (!body || typeof body !== "object") return false;
  return (body as { method?: unknown }).method === "tools/call";
}
