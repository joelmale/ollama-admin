import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    settings: { findUnique: vi.fn() },
    log: { deleteMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok status when database is healthy", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "1": 1 }]);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.checks.database).toBe("ok");
    expect(typeof data.checks.uptime).toBe("number");
    expect(data.timestamp).toBeDefined();
  });

  it("returns error status when database fails", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("DB connection failed"));

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe("error");
    expect(data.checks.database).toBe("error");
  });

  it("includes version in response", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "1": 1 }]);

    const response = await GET();
    const data = await response.json();

    expect(data.version).toBeDefined();
  });
});

describe("GET /api/health details", () => {
  it("reports the package version, not 'unknown'", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "1": 1 }]);
    const pkg = await import("@/package.json");

    const data = await (await GET()).json();

    expect(data.version).toBe(pkg.version);
  });

  it("reports a failed log purge as degraded without failing the healthcheck", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "1": 1 }]);
    vi.mocked(prisma.settings.findUnique).mockRejectedValue(new Error("database is locked"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runPurge } = await import("@/lib/runtime-settings");
    await runPurge();

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    expect(data.checks.logPurge).toBe("error");
    expect(data.logPurge.lastError).toContain("database is locked");
  });
});
