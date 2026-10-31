import { describe, expect, it } from "vitest";
import { isClientEndpoint, PROXY_QUICK_TIMEOUT_MS, proxyTimeoutMs } from "@/lib/proxy-policy";

describe("isClientEndpoint", () => {
  it.each(["/api/chat", "/api/chat/", "/api/chat///", "/v1/models/"])("allows %s", (path) => {
    expect(isClientEndpoint(path)).toBe(true);
  });

  it.each(["/api/pull", "/api/delete/", "/", "", "///", "/api/chat/extra"])("refuses %s", (path) => {
    expect(isClientEndpoint(path)).toBe(false);
  });

  it("handles a long run of slashes quickly", () => {
    const start = performance.now();
    isClientEndpoint("/api/chat" + "/".repeat(100_000) + "x");

    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe("proxyTimeoutMs", () => {
  it("lets generation run without a timeout", () => {
    expect(proxyTimeoutMs("/api/generate/")).toBeNull();
  });

  it("times out metadata calls", () => {
    expect(proxyTimeoutMs("/api/tags")).toBe(PROXY_QUICK_TIMEOUT_MS);
  });
});
