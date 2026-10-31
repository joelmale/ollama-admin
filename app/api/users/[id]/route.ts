import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { requireAdmin } from "@/lib/require-admin";
import { invalidateUserAccess } from "@/lib/user-access";

const ROLES = ["admin", "user"];
const LAST_ADMIN_ERROR =
  "Cannot remove the last admin. Make another user an active admin first.";

async function isLastActiveAdmin(id: string) {
  const others = await prisma.user.count({
    where: { role: "admin", active: true, id: { not: id } },
  });
  return others === 0;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username, password, role, active } = await req.json();

  if (role !== undefined && !ROLES.includes(role)) {
    return NextResponse.json(
      { error: `Role must be one of: ${ROLES.join(", ")}` },
      { status: 400 }
    );
  }
  if (password && password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }
  if (username !== undefined && (typeof username !== "string" || username.length < 3)) {
    return NextResponse.json(
      { error: "Username must be at least 3 characters" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const losesAdmin =
    target.role === "admin" &&
    target.active &&
    ((role !== undefined && role !== "admin") || active === false);
  if (losesAdmin && (await isLastActiveAdmin(id))) {
    return NextResponse.json({ error: LAST_ADMIN_ERROR }, { status: 400 });
  }

  if (username !== undefined && username !== target.username) {
    const taken = await prisma.user.findUnique({ where: { username } });
    if (taken) {
      return NextResponse.json({ error: "Username already exists" }, { status: 409 });
    }
  }

  const data: Record<string, unknown> = {};
  if (username !== undefined) data.username = username;
  if (role !== undefined) data.role = role;
  if (active !== undefined) data.active = Boolean(active);
  if (password) data.password = await hashPassword(password);

  const user = await prisma.user.update({
    where: { id: id },
    data,
    select: {
      id: true,
      username: true,
      role: true,
      active: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  invalidateUserAccess(id);

  return NextResponse.json(user);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (session.user.id === id) {
    return NextResponse.json(
      { error: "Cannot delete your own account" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id: id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "admin" && target.active && (await isLastActiveAdmin(id))) {
    return NextResponse.json({ error: LAST_ADMIN_ERROR }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: id } });
  invalidateUserAccess(id);
  return NextResponse.json({ ok: true });
}
