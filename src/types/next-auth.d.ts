import "next-auth";

declare module "next-auth" {
  interface User {
    /** Email and password sign-in only (see SessionPolicy / SessionAccess). */
    passwordAccount?: boolean;
    mustChangePassword?: boolean;
    pwdVersion?: number;
  }
}
