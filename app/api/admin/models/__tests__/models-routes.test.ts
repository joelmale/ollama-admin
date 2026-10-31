// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { server: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/pull-manager", () => ({
  pullManager: { startPull: vi.fn(), getStatus: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { pullManager } from "@/lib/pull-manager";
import { GET as listModels } from "@/app/api/admin/models/route";
import { GET as listRunning } from "@/app/api/admin/models/running/route";
import { POST as showModel } from "@/app/api/admin/models/show/route";
import { POST as copyModel } from "@/app/api/admin/models/copy/route";
import { DELETE as deleteModel } from "@/app/api/admin/models/delete/route";
import { POST as pullModel } from "@/app/api/admin/models/pull/route";
import { GET as pullStatus } from "@/app/api/admin/models/pull/status/route";

const findServer = prisma.server.findUnique as ReturnType<typeof vi.fn>;
const server = { id: "srv_1", name: "Local", url: "http://ollama:11434", active: true };

function get(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function json(path: string, method: string, body: object) {
  return new NextRequest(`http://localhost${path}`, { method, body: JSON.stringify(body) });
}

function ok(body: unknown) {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  findServer.mockResolvedValue(server);
  (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { role: "admin" } });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server lookup shared by the model routes", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["list", () => listModels(get("/api/admin/models?serverId=srv_1"))],
    ["running", () => listRunning(get("/api/admin/models/running?serverId=srv_1"))],
    ["show", () => showModel(json("/api/admin/models/show", "POST", { serverId: "srv_1", name: "m" }))],
    ["copy", () => copyModel(json("/api/admin/models/copy", "POST", { serverId: "srv_1", source: "a", destination: "b" }))],
    ["delete", () => deleteModel(json("/api/admin/models/delete", "DELETE", { serverId: "srv_1", name: "m" }))],
    ["pull", () => pullModel(json("/api/admin/models/pull", "POST", { serverId: "srv_1", name: "m" }))],
  ];

  it.each(calls)("%s returns 404 for an unknown server", async (_name, call) => {
    findServer.mockResolvedValue(null);

    expect((await call()).status).toBe(404);
  });

  it.each(calls)("%s refuses an inactive server", async (_name, call) => {
    findServer.mockResolvedValue({ ...server, active: false });

    expect((await call()).status).toBe(403);
  });

  it.each(calls)("%s reports an unreachable Ollama as 502", async (name, call) => {
    if (name === "pull") return;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    expect((await call()).status).toBe(502);
  });
});

describe("required parameters", () => {
  it.each([
    ["list", () => listModels(get("/api/admin/models"))],
    ["running", () => listRunning(get("/api/admin/models/running"))],
    ["show", () => showModel(json("/api/admin/models/show", "POST", { serverId: "srv_1" }))],
    ["copy", () => copyModel(json("/api/admin/models/copy", "POST", { serverId: "srv_1", source: "a" }))],
    ["delete", () => deleteModel(json("/api/admin/models/delete", "DELETE", { name: "m" }))],
    ["pull", () => pullModel(json("/api/admin/models/pull", "POST", { serverId: "srv_1" }))],
  ] as [string, () => Promise<Response>][])("%s returns 400", async (_name, call) => {
    expect((await call()).status).toBe(400);
  });
});

describe("successful calls", () => {
  it("lists installed and running models", async () => {
    vi.stubGlobal("fetch", ok({ models: [{ name: "llama3" }] }));

    expect(await (await listModels(get("/api/admin/models?serverId=srv_1"))).json()).toEqual({ models: [{ name: "llama3" }] });
    expect((await listRunning(get("/api/admin/models/running?serverId=srv_1"))).status).toBe(200);
  });

  it("shows, copies and deletes a model", async () => {
    vi.stubGlobal("fetch", ok({ modelfile: "FROM x" }));

    expect((await showModel(json("/x", "POST", { serverId: "srv_1", name: "m" }))).status).toBe(200);
    expect(await (await copyModel(json("/x", "POST", { serverId: "srv_1", source: "a", destination: "b" }))).json()).toEqual({ ok: true });
    expect(await (await deleteModel(json("/x", "DELETE", { serverId: "srv_1", name: "m" }))).json()).toEqual({ ok: true });
  });
});

describe("POST /api/admin/models/pull", () => {
  it("requires an admin", async () => {
    (requireAdmin as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await pullModel(json("/x", "POST", { serverId: "srv_1", name: "m" }));

    expect(res.status).toBe(403);
  });

  it("starts a background pull", async () => {
    (pullManager.startPull as ReturnType<typeof vi.fn>).mockReturnValue({ id: "srv_1:m", model: "m", tag: "latest", status: "pulling" });

    const res = await pullModel(json("/x", "POST", { serverId: "srv_1", name: "m" }));

    expect(res.status).toBe(202);
    expect(pullManager.startPull).toHaveBeenCalledWith("srv_1", server.url, "m");
  });

  it("passes a streaming pull through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status":"success"}\n')));

    const res = await pullModel(json("/x", "POST", { serverId: "srv_1", name: "m", stream: true }));

    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(await res.text()).toContain("success");
  });

  it("reports a rejected or unreachable streaming pull", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500, statusText: "Internal Server Error" })));
    expect((await pullModel(json("/x", "POST", { serverId: "srv_1", name: "m", stream: true }))).status).toBe(502);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await pullModel(json("/x", "POST", { serverId: "srv_1", name: "m", stream: true }))).status).toBe(502);
  });

  it("lists pull jobs, optionally for one server", async () => {
    (pullManager.getStatus as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await pullStatus(get("/api/admin/models/pull/status?serverId=srv_1"));
    await pullStatus(get("/api/admin/models/pull/status"));

    expect(pullManager.getStatus).toHaveBeenNthCalledWith(1, "srv_1");
    expect(pullManager.getStatus).toHaveBeenNthCalledWith(2, undefined);
  });
});
