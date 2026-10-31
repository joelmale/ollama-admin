export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/require-admin";
import { normalizeOllamaUrl } from "@/lib/ollama";
import { logger } from "@/lib/logger";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const server = await prisma.server.findUnique({
    where: { id: id },
  });

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json(server);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { name, url, gpuAgentUrl, active } = body;

  let normalizedUrl: string | undefined;
  if (url !== undefined) {
    try {
      normalizedUrl = normalizeOllamaUrl(url);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid URL" },
        { status: 400 }
      );
    }
  }

  try {
    const server = await prisma.server.update({
      where: { id: id },
      data: {
        ...(name !== undefined && { name }),
        ...(normalizedUrl !== undefined && { url: normalizedUrl }),
        ...(gpuAgentUrl !== undefined && { gpuAgentUrl: gpuAgentUrl || null }),
        ...(active !== undefined && { active }),
      },
    });
    return NextResponse.json(server);
  } catch {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const server = await prisma.server.findUnique({ where: { id: id } });
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  // Chats and logs reference the server with ON DELETE RESTRICT, so they go in
  // the same transaction. The UI warns about this and offers deactivation.
  try {
    const [logs, chats] = await prisma.$transaction([
      prisma.log.deleteMany({ where: { serverId: id } }),
      prisma.chat.deleteMany({ where: { serverId: id } }),
      prisma.server.delete({ where: { id: id } }),
    ]);
    logger.info("Server deleted", { name: server.name, logs: logs.count, chats: chats.count });
    return NextResponse.json({ ok: true, deletedLogs: logs.count, deletedChats: chats.count });
  } catch (error) {
    logger.error("Failed to delete server", { id, error: String(error) });
    return NextResponse.json(
      { error: "The server could not be deleted. Nothing was removed; check the server logs." },
      { status: 500 }
    );
  }
}
