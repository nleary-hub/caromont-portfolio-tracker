import { CredentialsSignin } from "next-auth";

/** Email and password failures. The code lands in the /signin URL: "invalid", "locked" or "limited", never why a password failed. */
export class PasswordSignInFailed extends CredentialsSignin {
  code = "invalid";
}

export class PasswordSignInLocked extends CredentialsSignin {
  code = "locked";
}

export class PasswordSignInLimited extends CredentialsSignin {
  code = "limited";
}
