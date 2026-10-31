import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { logAsync } from "@/lib/log-async";
import { withRateLimit } from "@/lib/with-rate-limit";
import { validateApiKey } from "@/lib/validate-api-key";
import { requireAdmin } from "@/lib/require-admin";
import { AUTH_DISABLED } from "@/lib/constants";
import { isClientEndpoint, proxyTimeoutMs } from "@/lib/proxy-policy";
import {
  buildOllamaUrl,
  formatOllamaConnectionError,
  isTimeoutError,
  redactOllamaUrl,
} from "@/lib/ollama";

async function proxyToOllama(req: NextRequest) {
  let apiKeyId: string | undefined;
  const hasApiKey = req.headers.get("authorization")?.startsWith("Bearer oa-");
  if (hasApiKey) {
    const { valid, keyId } = await validateApiKey(req);
    if (!valid) {
      logger.warn("Proxy auth failed", { ip: req.headers.get("x-forwarded-for") });
      return new Response(JSON.stringify({ error: "Invalid or revoked API key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    apiKeyId = keyId;
  }

  const path = req.nextUrl.pathname.replace("/api/proxy", "");
  const serverId = req.nextUrl.searchParams.get("serverId");

  if (!isClientEndpoint(path)) {
    const isAdmin = !hasApiKey && (AUTH_DISABLED || (await requireAdmin()) !== null);
    if (!isAdmin) {
      logger.warn("Proxy endpoint restricted", { path, apiKey: !!hasApiKey });
      return new Response(
        JSON.stringify({
          error: `${path} changes installed models and is restricted to admins. Use Admin → Models instead.`,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  logger.debug("Proxy request", { method: req.method, path, serverId });

  const server = serverId
    ? await prisma.server.findUnique({ where: { id: serverId } })
    : await prisma.server.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } });
  if (!server) {
    logger.warn("Proxy server not found", { serverId });
    return new Response(JSON.stringify({ error: "Server not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!server.active) {
    logger.warn("Proxy request to inactive server", { serverId, name: server.name });
    return new Response(JSON.stringify({ error: "Server is inactive" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startTime = Date.now();
  let body: string | null = null;
  let model = "unknown";
  let endpoint = path;

  if (req.method === "POST" || req.method === "PUT") {
    body = await req.text();
    try {
      const parsed = JSON.parse(body);
      if (parsed.model) model = parsed.model;
    } catch {
      // not JSON
    }
  }

  let ollamaUrl: string;
  let displayOllamaUrl = `${redactOllamaUrl(server.url)}${path}`;
  const bodySize = body ? body.length : 0;
  try {
    ollamaUrl = buildOllamaUrl(server.url, path);
    displayOllamaUrl = redactOllamaUrl(ollamaUrl);
  } catch (error) {
    const message = formatOllamaConnectionError(server.url, error);
    logger.error("Proxy connection failed", {
      ollamaUrl: displayOllamaUrl,
      error: message,
      model,
    });
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  logger.info("Proxy forwarding", { method: req.method, ollamaUrl: displayOllamaUrl, model, server: server.name, bodyBytes: bodySize });

  try {
    const timeoutMs = proxyTimeoutMs(path);
    const signals = [req.signal, ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])].filter(Boolean);
    const ollamaRes = await fetch(ollamaUrl, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body } : {}),
      signal: AbortSignal.any(signals as AbortSignal[]),
    });

    const latencyMs = Date.now() - startTime;
    const statusCode = ollamaRes.status;

    if (statusCode >= 400) {
      logger.warn("Proxy upstream error", { ollamaUrl: displayOllamaUrl, statusCode, latencyMs, model });
    } else {
      logger.debug("Proxy response", { ollamaUrl: displayOllamaUrl, statusCode, latencyMs });
    }

    logAsync({
      serverId: server.id,
      model,
      endpoint,
      latencyMs,
      statusCode,
      apiKeyId: apiKeyId ?? null,
      ip: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || null,
    });

    const responseBody = ollamaRes.body;
    return new Response(responseBody, {
      status: statusCode,
      headers: {
        "Content-Type": ollamaRes.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = formatOllamaConnectionError(server.url, err);
    const status = isTimeoutError(err) ? 504 : 502;

    logger.error("Proxy connection failed", { ollamaUrl: displayOllamaUrl, error: message, latencyMs, model });

    logAsync({
      serverId: server.id,
      model,
      endpoint,
      latencyMs,
      statusCode: status,
      apiKeyId: apiKeyId ?? null,
    });

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const GET = withRateLimit(proxyToOllama);
export const POST = withRateLimit(proxyToOllama);
export const PUT = withRateLimit(proxyToOllama);
export const DELETE = withRateLimit(proxyToOllama);
