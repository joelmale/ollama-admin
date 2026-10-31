import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimit,
  setRateLimitConfig,
  getRateLimitConfig,
} from "@/lib/rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimit("test-ip");
  setRateLimitConfig({ maxRequests: 5, windowMs: 10_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit", () => {
  it("allows requests within limit", () => {
    const result = checkRateLimit("test-ip");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it("decrements remaining tokens", () => {
    checkRateLimit("test-ip");
    checkRateLimit("test-ip");
    const result = checkRateLimit("test-ip");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks when tokens exhausted", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-ip");
    }
    const result = checkRateLimit("test-ip");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("refills tokens after window elapses", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-ip");
    }
    expect(checkRateLimit("test-ip").allowed).toBe(false);

    vi.advanceTimersByTime(10_000);
    const result = checkRateLimit("test-ip");
    expect(result.allowed).toBe(true);
  });

  it("tracks different keys independently", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("ip-a");
    }
    expect(checkRateLimit("ip-a").allowed).toBe(false);

    const result = checkRateLimit("ip-b");
    expect(result.allowed).toBe(true);
  });
});

describe("getRateLimitConfig", () => {
  it("returns current config", () => {
    const config = getRateLimitConfig();
    expect(config.maxRequests).toBe(5);
    expect(config.windowMs).toBe(10_000);
  });
});

describe("resetRateLimit", () => {
  it("resets tokens for a key", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("test-ip");
    }
    expect(checkRateLimit("test-ip").allowed).toBe(false);

    resetRateLimit("test-ip");
    const result = checkRateLimit("test-ip");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });
});

describe("getRateLimitKey", () => {
  it("buckets API-key clients by key, not by a forgeable header", async () => {
    const { getRateLimitKey } = await import("@/lib/with-rate-limit");
    const { NextRequest } = await import("next/server");
    const make = (headers: Record<string, string>) =>
      getRateLimitKey(new NextRequest("http://localhost/api/proxy/api/tags", { headers }));

    const a = make({ authorization: "Bearer oa-aaa", "x-forwarded-for": "1.1.1.1" });
    const b = make({ authorization: "Bearer oa-aaa", "x-forwarded-for": "2.2.2.2" });
    const c = make({ authorization: "Bearer oa-bbb" });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("oa-aaa");
    expect(make({ "x-forwarded-for": "3.3.3.3, 10.0.0.1" })).toBe("ip:3.3.3.3");
  });
});
