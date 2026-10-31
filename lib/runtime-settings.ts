import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { setRateLimitConfig, type RateLimitConfig } from "@/lib/rate-limit";

const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

export const SETTING_LIMITS = {
  logRetentionDays: { min: 0, max: 3650 },
  rateLimitMax: { min: 1, max: 100_000 },
  rateLimitWindow: { min: 1, max: 86_400 },
} as const;

export type NumericSetting = keyof typeof SETTING_LIMITS;

export function parseNumericSetting(key: NumericSetting, value: unknown): number | null {
  const n = Number(value);
  const { min, max } = SETTING_LIMITS[key];
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

async function readSetting(key: string): Promise<string | undefined> {
  const row = await prisma.settings.findUnique({ where: { key } });
  return row?.value;
}

/** The Settings value wins; LOG_RETENTION_DAYS is the default. 0 keeps logs forever. */
export async function getLogRetentionDays(): Promise<number> {
  const stored = parseNumericSetting("logRetentionDays", await readSetting("logRetentionDays"));
  if (stored !== null) return stored;
  const fromEnv = parseNumericSetting("logRetentionDays", process.env.LOG_RETENTION_DAYS);
  return fromEnv ?? DEFAULT_RETENTION_DAYS;
}

export async function purgeExpiredLogs(now = new Date()): Promise<number> {
  const days = await getLogRetentionDays();
  if (days === 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const { count } = await prisma.log.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (count > 0) logger.info("Purged expired logs", { count, retentionDays: days });
  return count;
}

export async function loadRateLimitConfig(): Promise<RateLimitConfig | null> {
  const max = parseNumericSetting("rateLimitMax", await readSetting("rateLimitMax"));
  const windowSec = parseNumericSetting("rateLimitWindow", await readSetting("rateLimitWindow"));
  if (max === null || windowSec === null) return null;
  return { maxRequests: max, windowMs: windowSec * 1000 };
}

export async function applyRateLimitSettings(): Promise<void> {
  const config = await loadRateLimitConfig();
  if (config) setRateLimitConfig(config);
}

// instrumentation.ts and route handlers are bundled separately, so state the
// health route reads must live on globalThis rather than in this module.
const globalJobs = globalThis as unknown as {
  backgroundJobsStarted?: boolean;
  logPurgeStatus?: { lastRunAt: string | null; lastError: string | null };
};
const purgeStatus = (globalJobs.logPurgeStatus ??= { lastRunAt: null, lastError: null });

export function getLogPurgeStatus() {
  return { ...purgeStatus };
}

export async function runPurge() {
  try {
    await purgeExpiredLogs();
    purgeStatus.lastError = null;
  } catch (error) {
    purgeStatus.lastError = String(error);
    logger.error("Log purge failed", { error: String(error) });
  } finally {
    purgeStatus.lastRunAt = new Date().toISOString();
  }
}

export function startBackgroundJobs() {
  if (globalJobs.backgroundJobsStarted) return;
  globalJobs.backgroundJobsStarted = true;

  void applyRateLimitSettings().catch((error) =>
    logger.error("Failed to load rate limit settings", { error: String(error) })
  );
  void runPurge();
  setInterval(runPurge, PURGE_INTERVAL_MS).unref?.();
}
