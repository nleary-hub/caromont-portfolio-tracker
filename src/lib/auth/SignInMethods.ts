import type { PasswordStatus } from "@/lib/services/UserAccountService";

export type SignInMethod = "google" | "password";

/**
 * The sign-in methods that work for one account, in tag order (Google, then Password). A temporary password
 * (mustChange) works for signing in, so it counts as Password; Must change password is a separate state tag.
 * Turned off ("Off") and Locked are state tags too and don't remove a method.
 */
export class SignInMethods {
  static readonly ORDER: readonly SignInMethod[] = ["google", "password"];

  /** `google`: Google sign-in lets this email in; when unknown, only accounts with no password are assumed Google. */
  static of(status: Pick<PasswordStatus, "state">, google?: boolean): SignInMethod[] {
    const hasGoogle = google ?? status.state === "none";
    const hasPassword = status.state === "active" || status.state === "mustChange";
    return SignInMethods.ORDER.filter((m) => (m === "google" ? hasGoogle : hasPassword));
  }
}
