import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));
vi.mock("@/lib/password", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));
vi.mock("@/lib/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/user-access", () => ({ invalidateUserAccess: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { invalidateUserAccess } from "@/lib/user-access";
import { DELETE, PUT } from "@/app/api/users/[id]/route";

const user = prisma.user as unknown as Record<string, ReturnType<typeof vi.fn>>;
const admin = { id: "admin1", username: "root", role: "admin", active: true };

function put(id: string, body: object) {
  return PUT(
    new Request(`http://localhost/api/users/${id}`, { method: "PUT", body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ id }) }
  );
}

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/users/${id}`, { method: "DELETE" }) as never, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: "admin1", role: "admin" } });
  user.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id === "admin1" ? admin : null
  );
  user.update.mockResolvedValue(admin);
});

describe("PUT /api/users/[id] last-admin protection", () => {
  it("refuses to demote the only active admin", async () => {
    user.count.mockResolvedValue(0);

    const res = await put("admin1", { role: "user" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("last admin");
    expect(user.update).not.toHaveBeenCalled();
  });

  it("refuses to deactivate the only active admin", async () => {
    user.count.mockResolvedValue(0);

    const res = await put("admin1", { active: false });

    expect(res.status).toBe(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("counts only other active admins", async () => {
    user.count.mockResolvedValue(0);

    await put("admin1", { role: "user" });

    expect(user.count).toHaveBeenCalledWith({
      where: { role: "admin", active: true, id: { not: "admin1" } },
    });
  });

  it("allows demotion when another active admin exists and refreshes access", async () => {
    user.count.mockResolvedValue(1);

    const res = await put("admin1", { role: "user" });

    expect(res.status).toBe(200);
    expect(invalidateUserAccess).toHaveBeenCalledWith("admin1");
  });

  it("rejects an unknown role", async () => {
    const res = await put("admin1", { role: "superadmin" });

    expect(res.status).toBe(400);
    expect(user.update).not.toHaveBeenCalled();
  });

  it("rejects a short password instead of ignoring it", async () => {
    const res = await put("admin1", { password: "short" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("8 characters");
  });

  it("returns 404 for a missing user", async () => {
    const res = await put("ghost", { role: "user" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when renaming to a taken username", async () => {
    user.findUnique.mockImplementation(async ({ where }: { where: { id?: string; username?: string } }) =>
      where.id === "admin1" ? admin : where.username === "taken" ? { id: "u2" } : null
    );

    const res = await put("admin1", { username: "taken" });

    expect(res.status).toBe(409);
  });
});

describe("DELETE /api/users/[id] last-admin protection", () => {
  beforeEach(() => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: "other", role: "admin" } });
  });

  it("allows deleting an admin when another active admin remains", async () => {
    user.count.mockResolvedValue(1);

    const res = await del("admin1");

    expect(res.status).toBe(200);
    expect(invalidateUserAccess).toHaveBeenCalledWith("admin1");
  });

  it("refuses when the remaining admins are all inactive", async () => {
    user.count.mockResolvedValue(0);

    const res = await del("admin1");

    expect(res.status).toBe(400);
    expect(user.delete).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing user", async () => {
    const res = await del("ghost");

    expect(res.status).toBe(404);
  });
});
