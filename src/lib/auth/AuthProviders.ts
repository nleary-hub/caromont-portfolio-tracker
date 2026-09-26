import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";

type Env = Record<string, string | undefined>;

/**
 * Sign-in providers. Google is the only provider; it reads AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET.
 * Access is still limited by SignInPolicy (ALLOWED_EMAILS / ADMIN_EMAILS) in the signIn callback.
 */
export class AuthProviders {
  static isGoogleConfigured(env: Env = process.env): boolean {
    return Boolean(env.AUTH_GOOGLE_ID?.trim() && env.AUTH_GOOGLE_SECRET?.trim());
  }

  static fromEnv(env: Env = process.env): Provider[] {
    return [Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET })];
  }
}
