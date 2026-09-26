/** Sign-in page error text. Deliberately generic: never reveal which check failed or what the lists contain. */
export class SignInMessages {
  static readonly ACCESS_DENIED = "This account is not on the access list.";
  static readonly CONFIGURATION = "Sign-in is misconfigured on the server.";
  static readonly GENERIC = "Sign-in failed. Please try again.";

  static forCode(code: string | undefined | null): string | null {
    if (!code) return null;
    if (code === "AccessDenied") return SignInMessages.ACCESS_DENIED;
    if (code === "Configuration") return SignInMessages.CONFIGURATION;
    return SignInMessages.GENERIC;
  }
}
