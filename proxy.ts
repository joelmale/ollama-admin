import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { getUserAccess } from "@/lib/user-access";

let setupCompleted = false;
let setupCheckedAt = 0;
let setupCheckInFlight: Promise<boolean | null> | null = null;
const SETUP_CACHE_TTL_MS = 60_000;

async function getSetupCompleted(): Promise<boolean | null> {
  if (setupCompleted && Date.now() - setupCheckedAt < SETUP_CACHE_TTL_MS) {
    return true;
  }

  // Share a cold-start lookup between concurrent requests on this instance.
  // Other instances independently read the same authoritative database value.
  if (setupCheckInFlight) return setupCheckInFlight;

  setupCheckInFlight = (async () => {
    try {
      const setting = await prisma.settings.findUnique({
        where: { key: "setup_completed" },
        select: { value: true },
      });
      setupCompleted = setting?.value === "true";
      if (setupCompleted) setupCheckedAt = Date.now();
      return setupCompleted;
    } catch (error) {
      // An unavailable setup check must not trap an already configured instance
      // in a redirect loop. Authentication and authorization still run normally.
      console.error("Failed to read setup state", error);
      return null;
    } finally {
      setupCheckInFlight = null;
    }
  })();

  return setupCheckInFlight;
}

function withNoCache(res: NextResponse, path: string): NextResponse {
  if (path.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

export async function proxy(req: NextRequest) {
  const start = Date.now();
  const { method } = req;
  const path = req.nextUrl.pathname;

  // Always allow static assets, auth endpoints, setup, health check
  const publicPaths = ["/api/auth", "/api/setup", "/api/health", "/_next", "/favicon.ico"];
  if (publicPaths.some((p) => path.startsWith(p))) {
    const res = withNoCache(NextResponse.next(), path);
    logForward(method, path, Date.now() - start);
    return res;
  }

  // Allow setup and auth pages without token
  if (path.startsWith("/setup") || path.startsWith("/auth")) {
    const res = NextResponse.next();
    logForward(method, path, Date.now() - start);
    return res;
  }

  // Redirect only when the authoritative setup state is known to be incomplete.
  // If the database check fails, continue to the normal authentication flow.
  const setupState = await getSetupCompleted();
  if (setupState === false) {
    logRequest(method, path, 302, Date.now() - start, "setup-redirect");
    const setupUrl = req.nextUrl.clone();
    setupUrl.pathname = "/setup";
    setupUrl.search = "";
    return NextResponse.redirect(setupUrl);
  }

  // Dev bypass — opt-in to disable auth for local development
  if (process.env.AUTH_DISABLED === "true") {
    const res = withNoCache(NextResponse.next(), path);
    logForward(method, path, Date.now() - start, "auth-disabled");
    return res;
  }

  // API keys authenticate only the Ollama gateway, where the key is validated.
  const authHeader = req.headers.get("authorization");
  const hasApiKey = !!authHeader && authHeader.startsWith("Bearer oa-");
  const isOllamaProxy = path === "/api/proxy" || path.startsWith("/api/proxy/");

  if (hasApiKey && isOllamaProxy) {
    const res = withNoCache(NextResponse.next(), path);
    logForward(method, path, Date.now() - start, "api-key");
    return res;
  }

  // Require authentication for everything else
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const access = token?.id ? await getUserAccess(token.id) : null;
  if (!token || !access) {
    if (path.startsWith("/api/")) {
      logRequest(method, path, 401, Date.now() - start, "unauthorized");
      return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const signInUrl = req.nextUrl.clone();
    signInUrl.pathname = "/auth/signin";
    signInUrl.search = "";
    signInUrl.searchParams.set("callbackUrl", path);
    logRequest(method, path, 302, Date.now() - start, "auth-redirect");
    return NextResponse.redirect(signInUrl);
  }

  // Admin-only routes
  const isAdminOnly =
    path.startsWith("/admin/") ||
    path.startsWith("/api/admin/") ||
    path.startsWith("/api/users") ||
    path.startsWith("/api/api-keys") ||
    path.startsWith("/settings");
  if (isAdminOnly && access.role !== "admin") {
    logRequest(method, path, 403, Date.now() - start, "forbidden");
    const homeUrl = req.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  const res = withNoCache(NextResponse.next(), path);
  logForward(method, path, Date.now() - start);
  return res;
}

function logForward(method: string, path: string, ms: number, note?: string) {
  if (path.startsWith("/_next")) return;
  const extra = note ? ` (${note})` : "";
  console.log(`${new Date().toISOString()} [HTTP] ${method} ${path} forward ${ms}ms${extra}`);
}

function logRequest(method: string, path: string, status: number, ms: number, note?: string) {
  if (path.startsWith("/_next")) return;
  const extra = note ? ` (${note})` : "";
  console.log(`${new Date().toISOString()} [HTTP] ${method} ${path} ${status} ${ms}ms${extra}`);
}

export const config = {
  matcher: [
    "/",
    "/api/:path*",
    "/admin/:path*",
    "/auth/:path*",
    "/chat",
    "/chat/:path*",
    "/discover",
    "/discover/:path*",
    "/gpu",
    "/gpu/:path*",
    "/settings",
    "/settings/:path*",
    "/setup",
    "/setup/:path*",
    "/tools",
    "/tools/:path*",
  ],
};
