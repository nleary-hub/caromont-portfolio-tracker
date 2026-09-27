"use server";

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn, SIGN_IN_PATH } from "@/auth";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { SessionPolicy } from "@/lib/auth/SessionPolicy";
import { PasswordSignInService } from "@/lib/services/PasswordSignInService";

/** First sign-in (a password session only). Server Actions are reachable by direct POST, so it resolves the session itself. */
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
