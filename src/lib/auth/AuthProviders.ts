import { DisplayName } from "@/lib/auth/DisplayName";
import { SessionPolicy } from "@/lib/auth/SessionPolicy";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";

type Env = Record<string, string | undefined>;

export interface ProviderSummary {
  id: string;
  name: string;
}

/**
 * Pluggable sign-in providers. Each provider is enabled only when its env vars exist.
 * To add another provider, add a descriptor to DESCRIPTORS.
 */
export class AuthProviders {
  private static readonly DESCRIPTORS: ReadonlyArray<{
    id: string;
    name: string;
    enabled: (env: Env) => boolean;
    build: (env: Env) => Provider;
  }> = [
    {
      id: "google",
      name: "Google",
      enabled: (env) => Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET),
      build: (env) => Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }),
    },
    {
      // Email and password (admin-created accounts only; see PasswordSignInService). On whenever the database is
      // configured; AUTH_PASSWORD_SIGNIN="false" turns it off. The account itself is the permission (SessionAccess).
      id: SessionPolicy.PASSWORD_PROVIDER,
      name: "Email and password",
      enabled: (env) => Boolean(env.DATABASE_URL) && env.AUTH_PASSWORD_SIGNIN !== "false",
      build: () =>
        Credentials({
          id: SessionPolicy.PASSWORD_PROVIDER,
          name: "Email and password",
          credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
          authorize: async (creds, request) => {
            // Loaded on use so the proxy bundle doesn't pull in Prisma and argon2 for every request.
            const [{ PasswordSignInService }, { SignInRateLimit }, { PasswordSignInFailed, PasswordSignInLimited, PasswordSignInLocked }] = await Promise.all([
              import("@/lib/services/PasswordSignInService"),
              import("@/lib/auth/SignInRateLimit"),
              import("@/lib/auth/PasswordSignInErrors"),
            ]);
            const ip = SignInRateLimit.clientIp(request?.headers);
            const result = await PasswordSignInService.authenticate(creds?.email, creds?.password, ip);
            if (result.ok) return { id: result.email, email: result.email, name: result.name, mustChangePassword: result.mustChange, pwdVersion: result.pwdVersion };
            throw result.reason === "locked" ? new PasswordSignInLocked() : result.reason === "limited" ? new PasswordSignInLimited() : new PasswordSignInFailed();
          },
        }),
    },
    {
      // Local development only: sign in by typing an (allowlisted) email. Never enabled in production builds.
      id: "dev-login",
      name: "Dev login",
      enabled: (env) => env.AUTH_DEV_LOGIN === "true" && env.NODE_ENV !== "production",
      build: () =>
        Credentials({
          id: "dev-login",
          name: "Dev login",
          credentials: { email: { label: "Email", type: "email" } },
          authorize: async (creds) => {
            const email = typeof creds?.email === "string" ? creds.email.trim().toLowerCase() : "";
            return email ? { id: email, email, name: DisplayName.fromEmail(email) } : null;
          },
        }),
    },
  ];

  static fromEnv(env: Env = process.env): Provider[] {
    return AuthProviders.DESCRIPTORS.filter((d) => d.enabled(env)).map((d) => d.build(env));
  }

  static summaries(env: Env = process.env): ProviderSummary[] {
    return AuthProviders.DESCRIPTORS.filter((d) => d.enabled(env)).map(({ id, name }) => ({ id, name }));
  }
}
