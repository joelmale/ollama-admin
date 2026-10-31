import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";

// API-key clients get their own bucket, so one app cannot exhaust another's
// limit and the bucket cannot be switched by forging X-Forwarded-For.
export function getRateLimitKey(req: NextRequest): string {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer oa-")) {
    return `key:${createHash("sha256").update(auth.slice(7)).digest("hex").slice(0, 16)}`;
  }
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

export function withRateLimit(
  handler: (req: NextRequest, ctx: any) => Promise<Response>
) {
  return async (req: NextRequest, ctx: any) => {
    const key = getRateLimitKey(req);
    const result = checkRateLimit(key);

    if (!result.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(result.resetMs / 1000)),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(result.resetMs),
          },
        }
      );
    }

    const response = await handler(req, ctx);

    const headers = new Headers(response.headers);
    headers.set("X-RateLimit-Remaining", String(result.remaining));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
