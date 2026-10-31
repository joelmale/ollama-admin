import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";

// Matches proxy.ts, which lets every request through when AUTH_DISABLED=true.
const DEV_ADMIN_SESSION: Session = {
  user: { id: "auth-disabled", name: "admin", role: "admin" },
  expires: new Date(8.64e15).toISOString(),
};

export async function requireAdmin() {
  if (process.env.AUTH_DISABLED === "true") return DEV_ADMIN_SESSION;
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== "admin") {
    return null;
  }
  return session;
}
