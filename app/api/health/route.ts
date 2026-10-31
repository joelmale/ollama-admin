import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getLogPurgeStatus } from "@/lib/runtime-settings";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

interface HealthStatus {
  status: "ok" | "degraded" | "error";
  version: string;
  timestamp: string;
  checks: {
    database: "ok" | "error";
    logPurge: "ok" | "error" | "pending";
    uptime: number;
  };
  logPurge: { lastRunAt: string | null; lastError: string | null };
}

const startTime = Date.now();

export async function GET() {
  let databaseStatus: "ok" | "error" = "ok";

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseStatus = "error";
  }

  const purge = getLogPurgeStatus();
  let logPurgeStatus: "ok" | "error" | "pending" = "pending";
  if (purge.lastError) logPurgeStatus = "error";
  else if (purge.lastRunAt) logPurgeStatus = "ok";

  // A failed purge is reported but does not fail the container healthcheck.
  let status: "ok" | "degraded" | "error" = "ok";
  if (databaseStatus === "error") status = "error";
  else if (logPurgeStatus === "error") status = "degraded";

  const health: HealthStatus = {
    status,
    version: pkg.version,
    timestamp: new Date().toISOString(),
    checks: {
      database: databaseStatus,
      logPurge: logPurgeStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    },
    logPurge: purge,
  };

  return NextResponse.json(health, { status: status === "error" ? 503 : 200 });
}
