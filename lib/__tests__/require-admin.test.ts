import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

import { getServerSession } from "next-auth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireAdmin", () => {
  it("returns session when user is admin", async () => {
    const session = { user: { id: "u1", role: "admin" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toEqual(session);
  });

  it("returns null when user is not admin", async () => {
    const session = { user: { id: "u1", role: "user" } };
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(session);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });

  it("treats AUTH_DISABLED like the middleware does and grants admin", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    try {
      const { requireAdmin } = await import("@/lib/require-admin");
      const result = await requireAdmin();

      expect(result?.user.role).toBe("admin");
      expect(getServerSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null when no session", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { requireAdmin } = await import("@/lib/require-admin");
    const result = await requireAdmin();

    expect(result).toBeNull();
  });
});
