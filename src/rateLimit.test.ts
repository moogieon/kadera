import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createRequestRateLimiter, shouldRateLimitRequest } from "./rateLimit.js";

describe("shouldRateLimitRequest", () => {
  it("does not count page assets, status checks, or MCP setup traffic", () => {
    expect(shouldRateLimitRequest("GET", "/", undefined)).toBe(false);
    expect(shouldRateLimitRequest("GET", "/api/runtime-status", undefined)).toBe(false);
    expect(shouldRateLimitRequest("POST", "/mcp", { method: "initialize" })).toBe(false);
    expect(shouldRateLimitRequest("POST", "/mcp", { method: "tools/list" })).toBe(false);
  });

  it("counts API work and MCP tool calls", () => {
    expect(shouldRateLimitRequest("POST", "/api/chat", {})).toBe(true);
    expect(shouldRateLimitRequest("POST", "/api/check-claim", {})).toBe(true);
    expect(shouldRateLimitRequest("POST", "/mcp", { method: "tools/call" })).toBe(true);
    expect(shouldRateLimitRequest("POST", "/mcp", [
      { method: "notifications/initialized" },
      { method: "tools/call" }
    ])).toBe(true);
  });
});

describe("createRequestRateLimiter", () => {
  it("does not spend the request budget while loading the chat screen", () => {
    const limiter = createRequestRateLimiter({ maxRequests: 1, mcpMaxRequests: 600, windowMs: 60_000, now: () => 1_000 });
    const nextMock = vi.fn();
    const next = nextMock as unknown as NextFunction;

    for (const path of ["/", "/styles.css", "/app.js", "/api/runtime-status", "/healthz"]) {
      limiter(mockRequest("GET", path), mockResponse(), next);
    }
    limiter(mockRequest("POST", "/api/chat"), mockResponse(), next);

    expect(nextMock).toHaveBeenCalledTimes(6);

    const blockedResponse = mockResponse();
    limiter(mockRequest("POST", "/api/chat"), blockedResponse, next);

    expect(blockedResponse.status).toHaveBeenCalledWith(429);
    expect(blockedResponse.setHeader).toHaveBeenCalledWith("Retry-After", "60");
    expect(blockedResponse.json).toHaveBeenCalledWith({
      error: "요청이 많습니다. 60초 후 다시 시도해주세요."
    });
  });
});

describe("MCP tool calls share one budget", () => {
  // Kakao Tools proxies every user through a few egress addresses. A per-IP
  // cap therefore throttles the whole product at once: eight manual test calls
  // were enough to make the tool answer "요청이 많습니다" to everybody.
  const mcpCall = (ip: string) => mockRequest("POST", "/mcp", { method: "tools/call" }, ip);

  it("does not exhaust the tool budget after a handful of calls from one address", () => {
    const limiter = createRequestRateLimiter({ maxRequests: 8, mcpMaxRequests: 600, windowMs: 60_000, now: () => 1_000 });
    const nextMock = vi.fn();
    for (let call = 0; call < 100; call += 1) {
      limiter(mcpCall("203.0.113.10"), mockResponse(), nextMock as unknown as NextFunction);
    }
    expect(nextMock).toHaveBeenCalledTimes(100);
  });

  it("keeps the browser budget per address so one visitor cannot spend another's", () => {
    const limiter = createRequestRateLimiter({ maxRequests: 1, mcpMaxRequests: 600, windowMs: 60_000, now: () => 1_000 });
    const nextMock = vi.fn();
    const next = nextMock as unknown as NextFunction;
    limiter(mockRequest("POST", "/api/chat", {}, "198.51.100.1"), mockResponse(), next);
    limiter(mockRequest("POST", "/api/chat", {}, "198.51.100.2"), mockResponse(), next);

    expect(nextMock).toHaveBeenCalledTimes(2);

    const blocked = mockResponse();
    limiter(mockRequest("POST", "/api/chat", {}, "198.51.100.1"), blocked, next);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });

  it("still refuses traffic once the shared guard is genuinely exceeded", () => {
    const limiter = createRequestRateLimiter({ maxRequests: 8, mcpMaxRequests: 2, windowMs: 60_000, now: () => 1_000 });
    const next = vi.fn() as unknown as NextFunction;
    limiter(mcpCall("203.0.113.10"), mockResponse(), next);
    limiter(mcpCall("203.0.113.11"), mockResponse(), next);

    const blocked = mockResponse();
    limiter(mcpCall("203.0.113.12"), blocked, next);
    expect(blocked.status).toHaveBeenCalledWith(429);
  });
});

function mockRequest(method: string, path: string, body: unknown = {}, ip = "203.0.113.10"): Request {
  return {
    method,
    path,
    body,
    ip,
    socket: { remoteAddress: ip }
  } as Request;
}

function mockResponse(): Response {
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn()
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response;
}
