import "next-auth";

declare module "next-auth" {
  interface User {
    /** Email and password sign-in only (see SessionPolicy / SessionAccess). */
    passwordAccount?: boolean;
    mustChangePassword?: boolean;
    pwdVersion?: number;
    /** Google sign-in allowed through an admin-created account rather than ALLOWED_EMAILS. */
    accountAccess?: boolean;
  }
}
