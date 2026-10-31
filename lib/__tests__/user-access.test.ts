import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";

const findUser = prisma.user.findUnique as ReturnType<typeof vi.fn>;

async function load() {
  return import("@/lib/user-access");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getUserAccess", () => {
  it("returns the current role for an active user", async () => {
    findUser.mockResolvedValue({ role: "admin", active: true });
    const { getUserAccess } = await load();

    expect(await getUserAccess("u1")).toEqual({ role: "admin" });
  });

  it("returns null for an inactive or deleted user", async () => {
    const { getUserAccess } = await load();
    findUser.mockResolvedValueOnce({ role: "user", active: false });
    expect(await getUserAccess("u1")).toBeNull();

    findUser.mockResolvedValueOnce(null);
    expect(await getUserAccess("u2")).toBeNull();
  });

  it("caches briefly and re-reads after the TTL", async () => {
    vi.useFakeTimers();
    findUser.mockResolvedValue({ role: "admin", active: true });
    const { getUserAccess } = await load();

    await getUserAccess("u1");
    await getUserAccess("u1");
    expect(findUser).toHaveBeenCalledTimes(1);

    findUser.mockResolvedValue({ role: "user", active: true });
    vi.advanceTimersByTime(31_000);
    expect(await getUserAccess("u1")).toEqual({ role: "user" });
  });

  it("re-reads immediately after invalidation", async () => {
    findUser.mockResolvedValue({ role: "admin", active: true });
    const { getUserAccess, invalidateUserAccess } = await load();
    await getUserAccess("u1");

    findUser.mockResolvedValue({ role: "user", active: false });
    invalidateUserAccess("u1");

    expect(await getUserAccess("u1")).toBeNull();
  });
});

describe("authOptions.callbacks.jwt", () => {
  it("refreshes the role from the database", async () => {
    findUser.mockResolvedValue({ role: "user", active: true });
    const { authOptions } = await import("@/lib/auth");

    const token = await authOptions.callbacks!.jwt!({ token: { id: "u1", role: "admin" } } as never);

    expect(token.role).toBe("user");
  });

  it("ends the session for a deactivated user", async () => {
    findUser.mockResolvedValue({ role: "admin", active: false });
    const { authOptions } = await import("@/lib/auth");

    await expect(
      authOptions.callbacks!.jwt!({ token: { id: "u1", role: "admin" } } as never)
    ).rejects.toThrow("inactive");
  });

  it("does not re-read on sign-in", async () => {
    const { authOptions } = await import("@/lib/auth");

    const token = await authOptions.callbacks!.jwt!({
      token: {},
      user: { id: "u1", role: "admin" },
    } as never);

    expect(token).toMatchObject({ id: "u1", role: "admin" });
    expect(findUser).not.toHaveBeenCalled();
  });
});
