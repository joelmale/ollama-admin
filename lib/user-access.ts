import { prisma } from "@/lib/prisma";

export interface UserAccess {
  role: string;
}

// Session tokens carry the role from sign-in; this re-reads the user so a
// deactivation, deletion or role change applies within one TTL, not at expiry.
const TTL_MS = 30_000;

const cache = new Map<string, { access: UserAccess | null; checkedAt: number }>();

export async function getUserAccess(userId: string): Promise<UserAccess | null> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.checkedAt < TTL_MS) return cached.access;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, active: true },
  });
  const access = user?.active ? { role: user.role } : null;
  cache.set(userId, { access, checkedAt: Date.now() });
  return access;
}

export function invalidateUserAccess(userId: string) {
  cache.delete(userId);
}
