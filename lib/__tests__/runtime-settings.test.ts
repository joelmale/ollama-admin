import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: { findUnique: vi.fn() },
    log: { deleteMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { getRateLimitConfig, setRateLimitConfig } from "@/lib/rate-limit";
import {
  applyRateLimitSettings,
  getLogRetentionDays,
  parseNumericSetting,
  purgeExpiredLogs,
} from "@/lib/runtime-settings";

const findSetting = prisma.settings.findUnique as ReturnType<typeof vi.fn>;
const deleteLogs = prisma.log.deleteMany as ReturnType<typeof vi.fn>;

function givenSettings(values: Record<string, string>) {
  findSetting.mockImplementation(async ({ where }: { where: { key: string } }) =>
    where.key in values ? { key: where.key, value: values[where.key] } : null
  );
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  deleteLogs.mockResolvedValue({ count: 0 });
  delete process.env.LOG_RETENTION_DAYS;
});

afterEach(() => {
  setRateLimitConfig({ maxRequests: 60, windowMs: 60_000 });
  vi.restoreAllMocks();
});

describe("getLogRetentionDays", () => {
  it("prefers the saved setting over the environment", async () => {
    process.env.LOG_RETENTION_DAYS = "30";
    givenSettings({ logRetentionDays: "7" });

    expect(await getLogRetentionDays()).toBe(7);
  });

  it("falls back to LOG_RETENTION_DAYS, then 90", async () => {
    givenSettings({});
    process.env.LOG_RETENTION_DAYS = "30";
    expect(await getLogRetentionDays()).toBe(30);

    delete process.env.LOG_RETENTION_DAYS;
    expect(await getLogRetentionDays()).toBe(90);
  });

  it("ignores an invalid saved value", async () => {
    givenSettings({ logRetentionDays: "soon" });

    expect(await getLogRetentionDays()).toBe(90);
  });
});

describe("purgeExpiredLogs", () => {
  it("deletes logs older than the retention period", async () => {
    givenSettings({ logRetentionDays: "10" });
    deleteLogs.mockResolvedValue({ count: 4 });
    const now = new Date("2026-06-30T00:00:00Z");

    expect(await purgeExpiredLogs(now)).toBe(4);
    expect(deleteLogs).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date(now.getTime() - 10 * DAY) } },
    });
  });

  it("keeps everything when retention is 0", async () => {
    givenSettings({ logRetentionDays: "0" });

    expect(await purgeExpiredLogs()).toBe(0);
    expect(deleteLogs).not.toHaveBeenCalled();
  });
});

describe("rate limit settings", () => {
  it("applies saved settings, converting the window from seconds", async () => {
    givenSettings({ rateLimitMax: "120", rateLimitWindow: "30" });

    await applyRateLimitSettings();

    expect(getRateLimitConfig()).toEqual({ maxRequests: 120, windowMs: 30_000 });
  });

  it("keeps the current limits when a saved value is invalid", async () => {
    givenSettings({ rateLimitMax: "0", rateLimitWindow: "30" });

    await applyRateLimitSettings();

    expect(getRateLimitConfig()).toEqual({ maxRequests: 60, windowMs: 60_000 });
  });
});

describe("parseNumericSetting", () => {
  it.each([
    ["logRetentionDays", "0", 0],
    ["logRetentionDays", "3651", null],
    ["rateLimitMax", "1.5", null],
    ["rateLimitWindow", "86400", 86400],
  ] as const)("%s=%s -> %s", (key, value, expected) => {
    expect(parseNumericSetting(key, value)).toBe(expected);
  });
});
