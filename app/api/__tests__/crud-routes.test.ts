// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chat: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    log: { findMany: vi.fn(), count: vi.fn() },
    server: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/require-active-setup-admin", () => ({ guardActiveSetupAdmin: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { guardActiveSetupAdmin } from "@/lib/require-active-setup-admin";
import * as chats from "@/app/api/chats/route";
import * as chat from "@/app/api/chats/[id]/route";
import * as logs from "@/app/api/logs/route";
import * as logExport from "@/app/api/logs/export/route";
import * as setupServer from "@/app/api/setup/server/route";
import * as setupPull from "@/app/api/setup/pull/route";
import * as serverHealth from "@/app/api/servers/[id]/health/route";
import * as gpuSpecs from "@/app/api/gpu/specs/route";

const p = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const server = { id: "srv_1", name: "Local", url: "http://ollama:11434", active: true, gpuAgentUrl: null };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string, init?: { method?: string; body?: object }) =>
  new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  (guardActiveSetupAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/api/chats", () => {
  it("searches titles and message content", async () => {
    p.chat.findMany.mockResolvedValue([]);

    await chats.GET(req("/api/chats?q=pasta"));

    expect(p.chat.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ title: { contains: "pasta" } }, { messages: { some: { content: { contains: "pasta" } } } }],
    });
  });

  it("creates a chat owned by the signed-in user", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: "u1" } });
    p.chat.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "c1", ...data }));

    const res = await chats.POST(req("/api/chats", { method: "POST", body: { model: "llama3", serverId: "srv_1", parameters: { temperature: 1 } } }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "New Conversation", userId: "u1", parameters: '{"temperature":1}' });
  });

  it("requires a model and server", async () => {
    const res = await chats.POST(req("/api/chats", { method: "POST", body: { model: "llama3" } }));

    expect(res.status).toBe(400);
  });
});

describe("/api/chats/[id]", () => {
  it("returns 404 for a missing chat", async () => {
    p.chat.findUnique.mockResolvedValue(null);

    expect((await chat.GET(req("/api/chats/x"), params("x"))).status).toBe(404);
  });

  it("updates only the provided fields", async () => {
    p.chat.update.mockResolvedValue({ id: "c1" });

    await chat.PUT(req("/api/chats/c1", { method: "PUT", body: { title: "Renamed", parameters: null } }), params("c1"));

    expect(p.chat.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { title: "Renamed", parameters: null } });
  });

  it("returns 404 when updating or deleting a missing chat", async () => {
    p.chat.update.mockRejectedValue(new Error("not found"));
    p.chat.delete.mockRejectedValue(new Error("not found"));

    expect((await chat.PUT(req("/api/chats/x", { method: "PUT", body: { title: "t" } }), params("x"))).status).toBe(404);
    expect((await chat.DELETE(req("/api/chats/x", { method: "DELETE" }), params("x"))).status).toBe(404);
  });

  it("deletes a chat", async () => {
    p.chat.delete.mockResolvedValue({});

    expect(await (await chat.DELETE(req("/api/chats/c1", { method: "DELETE" }), params("c1"))).json()).toEqual({ ok: true });
  });
});

describe("/api/logs", () => {
  it("filters and paginates", async () => {
    p.log.findMany.mockResolvedValue([]);
    p.log.count.mockResolvedValue(0);

    await logs.GET(req("/api/logs?serverId=srv_1&model=llama&status=error&from=2026-01-01&to=2026-02-01&page=3&limit=10"));

    expect(p.log.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        serverId: "srv_1",
        model: { contains: "llama" },
        statusCode: { gte: 400 },
        createdAt: { gte: new Date("2026-01-01"), lte: new Date("2026-02-01") },
      },
      skip: 20,
      take: 10,
    });
  });

  it("exports CSV", async () => {
    p.log.findMany.mockResolvedValue([
      { createdAt: new Date("2026-01-01T00:00:00Z"), server: { name: "Local" }, model: "llama3", endpoint: "/api/chat", promptTokens: 3, completionTokens: null, latencyMs: 12, statusCode: 200, userId: null, ip: "10.0.0.2" },
    ]);

    const res = await logExport.GET(req("/api/logs/export?format=csv&serverId=srv_1"));
    const text = await res.text();

    expect(res.headers.get("Content-Type")).toBe("text/csv");
    expect(text.split("\n")[1]).toBe("2026-01-01T00:00:00.000Z,Local,llama3,/api/chat,3,0,12,200,,10.0.0.2");
  });

  it("exports JSON by default", async () => {
    p.log.findMany.mockResolvedValue([]);

    const res = await logExport.GET(req("/api/logs/export"));

    expect(res.headers.get("Content-Disposition")).toContain("logs.json");
  });
});

describe("/api/setup/server", () => {
  it("returns the first server or 404", async () => {
    p.server.findFirst.mockResolvedValueOnce(server).mockResolvedValueOnce(null);

    expect((await setupServer.GET()).status).toBe(200);
    expect((await setupServer.GET()).status).toBe(404);
  });

  it("creates the first server with a normalized URL", async () => {
    p.server.create.mockImplementation(async ({ data }: { data: object }) => data);

    const res = await setupServer.POST(req("/api/setup/server", { method: "POST", body: { name: "Local", url: "http://ollama:11434/" } }));

    expect(res.status).toBe(201);
    expect((await res.json()).url).toBe("http://ollama:11434");
  });

  it("validates input", async () => {
    expect((await setupServer.POST(req("/x", { method: "POST", body: { name: "Local" } }))).status).toBe(400);
    expect((await setupServer.POST(req("/x", { method: "POST", body: { name: "Local", url: "ftp://nope" } }))).status).toBe(400);
  });

  it("is blocked by the setup guard", async () => {
    (guardActiveSetupAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(null, { status: 403 }));

    expect((await setupServer.GET()).status).toBe(403);
    expect((await setupServer.POST(req("/x", { method: "POST", body: {} }))).status).toBe(403);
    expect((await setupPull.POST(req("/x", { method: "POST", body: {} }))).status).toBe(403);
  });
});

describe("/api/setup/pull", () => {
  it("streams the pull", async () => {
    p.server.findUnique.mockResolvedValue(server);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"success"}\n')));

    const res = await setupPull.POST(req("/x", { method: "POST", body: { serverId: "srv_1", name: "llama3" } }));

    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
  });

  it("handles missing input, unknown servers and Ollama failures", async () => {
    expect((await setupPull.POST(req("/x", { method: "POST", body: { serverId: "srv_1" } }))).status).toBe(400);

    p.server.findUnique.mockResolvedValue(null);
    expect((await setupPull.POST(req("/x", { method: "POST", body: { serverId: "x", name: "m" } }))).status).toBe(404);

    p.server.findUnique.mockResolvedValue(server);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await setupPull.POST(req("/x", { method: "POST", body: { serverId: "srv_1", name: "m" } }))).status).toBe(502);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect((await setupPull.POST(req("/x", { method: "POST", body: { serverId: "srv_1", name: "m" } }))).status).toBe(502);
  });
});

describe("/api/servers/[id]/health", () => {
  it("reports online, offline and missing servers", async () => {
    p.server.findUnique.mockResolvedValue(server);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"version":"0.12.0"}')));
    expect(await (await serverHealth.GET(req("/x"), params("srv_1"))).json()).toEqual({ id: "srv_1", status: "online", version: "0.12.0" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await (await serverHealth.GET(req("/x"), params("srv_1"))).json()).status).toBe("offline");

    p.server.findUnique.mockResolvedValue(null);
    expect((await serverHealth.GET(req("/x"), params("x"))).status).toBe(404);
  });
});

describe("/api/gpu/specs", () => {
  it("returns null without a GPU agent", async () => {
    p.server.findFirst.mockResolvedValue(server);

    expect(await (await gpuSpecs.GET(new Request("http://localhost/api/gpu/specs"))).json()).toBeNull();
  });

  it("looks up specs for the reported GPU", async () => {
    p.server.findUnique.mockResolvedValue({ ...server, gpuAgentUrl: "http://gpu:11435" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify([{ name: "NVIDIA GeForce RTX 4090", memoryTotal: 24 * 1024 ** 3 }])))
    );

    const data = await (await gpuSpecs.GET(new Request("http://localhost/api/gpu/specs?serverId=srv_1"))).json();

    expect(data).toMatchObject({ gpuName: "NVIDIA GeForce RTX 4090", vramGB: 24 });
  });

  it("returns null when the agent fails", async () => {
    p.server.findUnique.mockResolvedValue({ ...server, gpuAgentUrl: "http://gpu:11435" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(await (await gpuSpecs.GET(new Request("http://localhost/api/gpu/specs?serverId=srv_1"))).json()).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await (await gpuSpecs.GET(new Request("http://localhost/api/gpu/specs?serverId=srv_1"))).json()).toBeNull();
  });
});
