import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";

export interface SignInPanel {
  tone: "error" | "warning" | "info";
  title: string | null;
  body: string;
}

/** Sign-in page error text. Deliberately generic: never reveal which check failed or what the lists contain. */
export class SignInMessages {
  /** Every refused Google sign-in (not on the list, turned off, unverified): same words as LineAccessCopy.NOT_ALLOWED_EMAIL. */
  static readonly ACCESS_DENIED = LineAccessCopy.NOT_ALLOWED_EMAIL;
  static readonly CONFIGURATION = "Sign-in is misconfigured on the server.";
  static readonly GENERIC = "Sign-in failed. Please try again.";

  static readonly PASSWORD_INVALID = PasswordCopy.INVALID;
  static readonly PASSWORD_LOCKED = PasswordCopy.LOCKED;
  static readonly PASSWORD_LIMITED = PasswordCopy.LIMITED;

  /**
   * The panel on /signin: red for errors, amber for the lockout and rate limit, gray for "Your session ended".
   * `detail` is the Auth.js `code` for credentials errors ("locked", "limited", anything else = the generic text).
   */
  static panel(code: string | undefined | null, detail?: string | null, ended = false): SignInPanel | null {
    if (code === "CredentialsSignin" && detail === "locked") return { tone: "warning", title: PasswordCopy.LOCKED_TITLE, body: PasswordCopy.LOCKED };
    if (code === "CredentialsSignin" && detail === "limited") return { tone: "warning", title: PasswordCopy.LIMITED_TITLE, body: PasswordCopy.LIMITED };
    const text = SignInMessages.forCode(code, detail);
    if (text) return { tone: "error", title: null, body: text };
    return ended ? { tone: "info", title: PasswordCopy.ENDED_TITLE, body: PasswordCopy.ENDED } : null;
  }

  static forCode(code: string | undefined | null, detail?: string | null): string | null {
    if (!code) return null;
    if (code === "CredentialsSignin") {
      if (detail === "locked") return SignInMessages.PASSWORD_LOCKED;
      if (detail === "limited") return SignInMessages.PASSWORD_LIMITED;
      return SignInMessages.PASSWORD_INVALID;
    }
    if (code === "AccessDenied") return SignInMessages.ACCESS_DENIED;
    if (code === "Configuration") return SignInMessages.CONFIGURATION;
    return SignInMessages.GENERIC;
  }
}
