"use server";

import { revalidatePath } from "next/cache";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { DepartmentAccessService } from "@/lib/services/DepartmentAccessService";
import { UserAccountService, type AccountResult } from "@/lib/services/UserAccountService";

/**
 * Admin account actions for Admin > People > Access. Server Actions are reachable by direct POST, so each re-checks
 * admin from the session (UserAccountService checks again). Passwords are never logged.
 */
class AdminAction {
  static async run(work: (viewer: NonNullable<Awaited<ReturnType<typeof CurrentViewer.get>>>) => Promise<AccountResult>, failure: string): Promise<AccountResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, message: failure };
    try {
      const result = await work(viewer);
      if (result.ok) {
        revalidatePath("/admin/people");
        revalidatePath("/", "layout");
      }
      return result;
    } catch (e) {
      console.error("Account change failed", (e as Error)?.name ?? "error");
      return { ok: false, message: failure };
    }
  }
}

/** Add user: account, line access, department limits and (optionally) a temporary password in one save. */
export async function addUserAccount(input: { email: string; name: string; lineIds: string[]; createPassword: boolean; departments?: Record<string, string[]> }): Promise<AccountResult> {
  return AdminAction.run((viewer) => UserAccountService.addUser(viewer, input, undefined, undefined, DepartmentAccessService.addUserHook(input?.departments)), LineAccessCopy.SAVE_ERROR);
}

export async function resetUserPassword(email: string): Promise<AccountResult> {
  return AdminAction.run((viewer) => UserAccountService.resetPassword(viewer, email), PasswordCopy.SAVE_ERROR);
}

export async function unlockUser(email: string): Promise<AccountResult> {
  return AdminAction.run((viewer) => UserAccountService.unlock(viewer, email), PasswordCopy.SAVE_ERROR);
}

export async function setPasswordSignIn(email: string, on: boolean): Promise<AccountResult> {
  return AdminAction.run((viewer) => UserAccountService.setEnabled(viewer, email, on === true), PasswordCopy.SAVE_ERROR);
}
