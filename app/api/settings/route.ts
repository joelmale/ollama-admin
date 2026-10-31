export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import {
  SETTING_LIMITS,
  applyRateLimitSettings,
  parseNumericSetting,
  type NumericSetting,
} from "@/lib/runtime-settings";

export async function GET() {
  const settings = await prisma.settings.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  return NextResponse.json(result);
}

export async function PUT(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data = await req.json();

  for (const [key, value] of Object.entries(data)) {
    if (key in SETTING_LIMITS && parseNumericSetting(key as NumericSetting, value) === null) {
      const { min, max } = SETTING_LIMITS[key as NumericSetting];
      return NextResponse.json(
        { error: `${key} must be a whole number between ${min} and ${max}` },
        { status: 400 }
      );
    }
  }

  await prisma.$transaction(
    Object.entries(data).map(([key, value]) =>
      prisma.settings.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      })
    )
  );

  if ("rateLimitMax" in data || "rateLimitWindow" in data) {
    await applyRateLimitSettings();
  }

  return NextResponse.json({ ok: true });
}
