import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    server: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    log: { deleteMany: vi.fn() },
    chat: { deleteMany: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("@/lib/require-admin", () => ({
  requireAdmin: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";

const mockServer = {
  id: "srv_1",
  name: "Local Ollama",
  url: "http://localhost:11434",
  gpuAgentUrl: null,
  active: true,
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: "admin_1", role: "admin" },
  });
});

describe("GET /api/servers", () => {
  it("returns only safe active-server fields to regular users", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.server.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "srv_1", name: "Local Ollama" },
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const res = await GET(new NextRequest("http://localhost/api/servers"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual([{ id: "srv_1", name: "Local Ollama" }]);
    expect(prisma.server.findMany).toHaveBeenCalledWith({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("forbids regular users from requesting full server records", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { GET } = await import("@/app/api/servers/route");
    const res = await GET(
      new NextRequest("http://localhost/api/servers?all=true")
    );

    expect(res.status).toBe(403);
    expect(prisma.server.findMany).not.toHaveBeenCalled();
  });

  it("returns only active servers by default", async () => {
    (prisma.server.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const req = new NextRequest("http://localhost/api/servers");
    const res = await GET(req);
    const data = await res.json();

    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Local Ollama");
    expect(prisma.server.findMany).toHaveBeenCalledWith(
      {
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      }
    );
  });

  it("returns all servers when all=true", async () => {
    (prisma.server.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockServer,
      { ...mockServer, id: "srv_2", name: "Inactive", active: false },
    ]);

    const { GET } = await import("@/app/api/servers/route");
    const req = new NextRequest("http://localhost/api/servers?all=true");
    const res = await GET(req);
    const data = await res.json();

    expect(data).toHaveLength(2);
    expect(prisma.server.findMany).toHaveBeenCalledWith(
      { orderBy: { createdAt: "asc" } }
    );
  });
});

describe("POST /api/servers", () => {
  it("forbids non-admin users", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Internal target",
        url: "http://169.254.169.254",
      }),
    });

    const res = await POST(req as any);

    expect(res.status).toBe(403);
    expect(prisma.server.create).not.toHaveBeenCalled();
  });

  it("creates a server with valid data", async () => {
    (prisma.server.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockServer
    );

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Local Ollama",
        url: "http://localhost:11434",
      }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.name).toBe("Local Ollama");
  });

  it("returns 400 when name is missing", async () => {
    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({ url: "http://localhost:11434" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it("strips trailing slash from URL", async () => {
    (prisma.server.create as ReturnType<typeof vi.fn>).mockImplementation(
      ({ data }) => Promise.resolve({ ...mockServer, ...data })
    );

    const { POST } = await import("@/app/api/servers/route");
    const req = new Request("http://localhost/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        url: "http://localhost:11434/",
      }),
    });
    await POST(req as any);

    expect(prisma.server.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: "http://localhost:11434",
        }),
      })
    );
  });
});

describe("DELETE /api/servers/[id]", () => {
  it("forbids non-admin users", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, {
      params: Promise.resolve({ id: "srv_1" }),
    });

    expect(res.status).toBe(403);
    expect(prisma.server.delete).not.toHaveBeenCalled();
  });

  it("deletes a used server together with its chats and logs", async () => {
    (prisma.server.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockServer);
    (prisma.log.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 12 });
    (prisma.chat.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });
    (prisma.server.delete as ReturnType<typeof vi.fn>).mockResolvedValue(mockServer);

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deletedLogs: 12, deletedChats: 3 });
    expect(prisma.log.deleteMany).toHaveBeenCalledWith({ where: { serverId: "srv_1" } });
    expect(prisma.chat.deleteMany).toHaveBeenCalledWith({ where: { serverId: "srv_1" } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for non-existent server", async () => {
    (prisma.server.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/nope", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, { params: Promise.resolve({ id: "nope" }) });

    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reports a failed delete as a server error, not a missing server", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    (prisma.server.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockServer);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Foreign key constraint failed")
    );

    const { DELETE } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "DELETE",
    });
    const res = await DELETE(req as any, { params: Promise.resolve({ id: "srv_1" }) });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Nothing was removed");
  });
});

describe("PUT /api/servers/[id]", () => {
  it("forbids non-admin users", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { PUT } = await import("@/app/api/servers/[id]/route");
    const req = new Request("http://localhost/api/servers/srv_1", {
      method: "PUT",
      body: JSON.stringify({ url: "http://169.254.169.254" }),
    });
    const res = await PUT(req as any, {
      params: Promise.resolve({ id: "srv_1" }),
    });

    expect(res.status).toBe(403);
    expect(prisma.server.update).not.toHaveBeenCalled();
  });
});
