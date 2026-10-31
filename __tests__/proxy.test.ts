import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

vi.mock("@/lib/user-access", () => ({
  getUserAccess: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { getToken } from "next-auth/jwt";
import { getUserAccess } from "@/lib/user-access";

const findSetupSetting = prisma.settings.findUnique as ReturnType<typeof vi.fn>;
const getAuthToken = getToken as ReturnType<typeof vi.fn>;
const getAccess = getUserAccess as ReturnType<typeof vi.fn>;

async function loadProxy() {
  const { proxy } = await import("@/proxy");
  return proxy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  getAuthToken.mockResolvedValue({ id: "u1", role: "admin" });
  getAccess.mockResolvedValue({ role: "admin" });
});

describe("proxy setup guard", () => {
  it("labels pass-through requests as forward instead of a false 200", async () => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const proxy = await loadProxy();

    await proxy(
      new NextRequest("http://localhost/api/servers/srv_1/test", {
        method: "POST",
      })
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[HTTP] POST /api/servers/srv_1/test forward"
      )
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/servers/srv_1/test 200")
    );
    logSpy.mockRestore();
  });

  it("reads completed setup state from the database without a self-fetch", async () => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const proxy = await loadProxy();

    const response = await proxy(new NextRequest("https://app.example.com/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(findSetupSetting).toHaveBeenCalledWith({
      where: { key: "setup_completed" },
      select: { value: true },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("serves concurrent requests without re-entering the public host", async () => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const proxy = await loadProxy();

    const responses = await Promise.all(
      Array.from({ length: 24 }, () =>
        proxy(new NextRequest("https://app.example.com/admin/metrics"))
      )
    );

    expect(responses).toHaveLength(24);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => !response.headers.has("location"))).toBe(true);
    expect(findSetupSetting).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("caches only a completed setup result", async () => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    const proxy = await loadProxy();

    await proxy(new NextRequest("http://localhost/"));
    await proxy(new NextRequest("http://localhost/admin/servers"));

    expect(findSetupSetting).toHaveBeenCalledTimes(1);
  });

  it("does not cache an incomplete setup result", async () => {
    findSetupSetting
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ value: "true" });
    const proxy = await loadProxy();

    const firstResponse = await proxy(new NextRequest("http://localhost/"));
    const secondResponse = await proxy(new NextRequest("http://localhost/"));

    expect(firstResponse.status).toBe(307);
    expect(secondResponse.status).toBe(200);
    expect(findSetupSetting).toHaveBeenCalledTimes(2);
  });

  it("redirects when setup is known to be incomplete", async () => {
    findSetupSetting.mockResolvedValue(null);
    const proxy = await loadProxy();

    const response = await proxy(new NextRequest("http://localhost/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/setup");
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it("fails open to authentication when setup state cannot be read", async () => {
    findSetupSetting.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const proxy = await loadProxy();

    const response = await proxy(new NextRequest("http://localhost/"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(getAuthToken).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to read setup state",
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });

  it("still requires a session when the setup check fails", async () => {
    findSetupSetting.mockRejectedValue(new Error("database unavailable"));
    getAuthToken.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const proxy = await loadProxy();

    const pageResponse = await proxy(new NextRequest("http://localhost/admin/servers"));
    const apiResponse = await proxy(new NextRequest("http://localhost/api/servers"));

    expect(pageResponse.status).toBe(307);
    expect(pageResponse.headers.get("location")).toBe(
      "http://localhost/auth/signin?callbackUrl=%2Fadmin%2Fservers"
    );
    expect(apiResponse.status).toBe(401);
    errorSpy.mockRestore();
  });

  it("does not accept an unvalidated API key on administrative APIs", async () => {
    findSetupSetting.mockRejectedValue(new Error("database unavailable"));
    getAuthToken.mockResolvedValue(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const proxy = await loadProxy();

    const response = await proxy(
      new NextRequest("http://localhost/api/admin/models/delete", {
        headers: { authorization: "Bearer oa-not-a-real-key" },
      })
    );

    expect(response.status).toBe(401);
    expect(getAuthToken).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("allows API keys to reach the Ollama proxy for endpoint validation", async () => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    const proxy = await loadProxy();

    const response = await proxy(
      new NextRequest("http://localhost/api/proxy/api/tags", {
        headers: { authorization: "Bearer oa-candidate-key" },
      })
    );

    expect(response.status).toBe(200);
    expect(getAuthToken).not.toHaveBeenCalled();
  });

  it("does not query setup state for public setup endpoints", async () => {
    const proxy = await loadProxy();

    const response = await proxy(
      new NextRequest("http://localhost/api/setup/status")
    );

    expect(response.status).toBe(200);
    expect(findSetupSetting).not.toHaveBeenCalled();
  });
});

describe("proxy session revalidation", () => {
  beforeEach(() => {
    findSetupSetting.mockResolvedValue({ value: "true" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("rejects a valid token for a deactivated or deleted user", async () => {
    getAccess.mockResolvedValue(null);
    const proxy = await loadProxy();

    const res = await proxy(new NextRequest("http://localhost/api/chats"));

    expect(res.status).toBe(401);
    expect(getAccess).toHaveBeenCalledWith("u1");
  });

  it("uses the current database role, not the role in the token", async () => {
    getAccess.mockResolvedValue({ role: "user" });
    const proxy = await loadProxy();

    const res = await proxy(new NextRequest("http://localhost/api/users"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/");
  });

  it("rejects a token without a user id", async () => {
    getAuthToken.mockResolvedValue({ role: "admin" });
    const proxy = await loadProxy();

    const res = await proxy(new NextRequest("http://localhost/api/chats"));

    expect(res.status).toBe(401);
  });
});
