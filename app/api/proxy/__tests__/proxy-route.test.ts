// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { server: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/validate-api-key", () => ({ validateApiKey: vi.fn() }));
vi.mock("@/lib/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/log-async", () => ({ logAsync: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, resetMs: 1000 })),
}));

import { prisma } from "@/lib/prisma";
import { validateApiKey } from "@/lib/validate-api-key";
import { requireAdmin } from "@/lib/require-admin";
import { logAsync } from "@/lib/log-async";
import { DELETE, GET, POST } from "@/app/api/proxy/[...path]/route";

const server = { id: "srv_1", name: "Local", url: "http://ollama:11434", active: true };

function request(path: string, init: { method?: string; body?: string; apiKey?: boolean; signal?: AbortSignal } = {}) {
  return new NextRequest(`http://localhost/api/proxy${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    signal: init.signal,
    headers: init.apiKey ? { authorization: "Bearer oa-testkey" } : {},
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  (prisma.server.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(server);
  (prisma.server.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(server);
  (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true, keyId: "key_1" });
  (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("proxy endpoint policy", () => {
  it.each([
    ["DELETE", "/api/delete"],
    ["POST", "/api/pull"],
    ["POST", "/api/create"],
    ["POST", "/api/copy"],
    ["POST", "/api/push"],
  ])("blocks %s %s for a non-admin session", async (method, path) => {
    vi.stubGlobal("fetch", vi.fn());
    const handler = method === "DELETE" ? DELETE : POST;

    const res = await handler(request(path, { method, body: "{}" }), {});

    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks model management for API keys even when an admin is signed in", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: "admin" } });
    vi.stubGlobal("fetch", vi.fn());

    const res = await DELETE(request("/api/delete", { method: "DELETE", body: "{}", apiKey: true }), {});

    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets an admin session manage models", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: "admin" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    const res = await DELETE(request("/api/delete", { method: "DELETE", body: '{"model":"x"}' }), {});

    expect(res.status).toBe(200);
  });

  it.each(["/api/chat", "/api/generate", "/api/embed", "/v1/chat/completions"])(
    "allows %s for API keys",
    async (path) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

      const res = await POST(request(path, { method: "POST", body: '{"model":"llama3"}', apiKey: true }), {});

      expect(res.status).toBe(200);
      expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: "key_1", model: "llama3" }));
    }
  );

  it("rejects an invalid API key before contacting Ollama", async () => {
    (validateApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false });
    vi.stubGlobal("fetch", vi.fn());

    const res = await GET(request("/api/tags", { apiKey: true }), {});

    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("proxy timeouts and cancellation", () => {
  it("applies a timeout to metadata calls and returns 504 when it fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBeDefined();
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );

    const res = await GET(request("/api/tags"), {});

    expect(res.status).toBe(504);
    expect((await res.json()).error).toContain("did not respond in time");
    expect(logAsync).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 504 }));
  });

  it("aborts the upstream request when the client disconnects", async () => {
    const client = new AbortController();
    let upstream: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        upstream = init.signal!;
        return new Response("{}", { status: 200 });
      })
    );

    await POST(request("/api/generate", { method: "POST", body: "{}", signal: client.signal }), {});
    client.abort();

    expect(upstream?.aborted).toBe(true);
  });

  it("returns 404 when no server is configured", async () => {
    (prisma.server.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await GET(request("/api/tags"), {});

    expect(res.status).toBe(404);
  });

  it("refuses an inactive server", async () => {
    (prisma.server.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...server, active: false });

    const res = await GET(request("/api/tags?serverId=srv_1"), {});

    expect(res.status).toBe(403);
  });
});