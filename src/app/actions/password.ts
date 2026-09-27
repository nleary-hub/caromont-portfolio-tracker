"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn, SIGN_IN_PATH } from "@/auth";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { SessionPolicy } from "@/lib/auth/SessionPolicy";
import { PasswordSignInService } from "@/lib/services/PasswordSignInService";
import { UserAccountService, type AccountResult } from "@/lib/services/UserAccountService";

/**
 * Password actions. Server Actions are reachable by direct POST, so each resolves the session itself: the admin ones
 * re-check admin (UserAccountService checks again), the first sign-in one needs a password session. Passwords are
 * never logged.
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

/** Add user: account, line access and (optionally) a temporary password in one save. */
export async function addUserAccount(input: { email: string; name: string; lineIds: string[]; createPassword: boolean }): Promise<AccountResult> {
  return AdminAction.run((viewer) => UserAccountService.addUser(viewer, input), LineAccessCopy.SAVE_ERROR);
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

/**
 * First sign-in: replace the temporary password, then sign in again with the new one. That issues a fresh 7 day
 * session without the temporary flag (the old session ends because its password version changed).
 */
export async function chooseOwnPassword(_prev: { message: string | null }, formData: FormData): Promise<{ message: string | null }> {
  const session = await auth();
  const email = session?.user?.passwordAccount ? session.user.email : null;
  if (!email) redirect(SIGN_IN_PATH);
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  let result;
  try {
    result = await PasswordSignInService.changeOwnPassword(email, password, confirm);
  } catch (e) {
    console.error("Password change failed", (e as Error)?.name ?? "error");
    return { message: PasswordCopy.SAVE_ERROR };
  }
  if (!result.ok) return { message: result.message };
  try {
    await signIn(SessionPolicy.PASSWORD_PROVIDER, { email, password, redirectTo: "/" });
  } catch (error) {
    if (error instanceof AuthError) redirect(`${SIGN_IN_PATH}?error=${encodeURIComponent(error.type)}`);
    throw error; // the success redirect
  }
  return { message: null };
}
