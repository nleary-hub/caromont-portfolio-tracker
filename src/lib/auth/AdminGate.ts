import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

/** Server-side admin enforcement for pages, Server Functions and Route Handlers. Non-admins get a 404. */
export class AdminGate {
  /** The signed-in admin's email, or null. */
  static async adminEmail(): Promise<string | null> {
    const session = await auth();
    const email = session?.user?.email ?? null;
    if (!email || !EmailAllowlist.isAllowed(email) || !AdminPolicy.isAdmin(email)) return null;
    return email.trim().toLowerCase();
  }

  /** Returns the admin's email or throws Next's 404. */
  static async requireAdmin(): Promise<string> {
    const email = await AdminGate.adminEmail();
    if (!email) notFound();
    return email;
  }
}
