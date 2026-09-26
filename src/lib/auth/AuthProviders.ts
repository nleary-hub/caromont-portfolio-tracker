import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

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
      id: "microsoft-entra-id",
      name: "Microsoft",
      enabled: (env) => Boolean(env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET),
      build: (env) =>
        MicrosoftEntraID({
          clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
          clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
          // Tenant-specific issuer strongly recommended: https://login.microsoftonline.com/<tenant-id>/v2.0/
          ...(env.AUTH_MICROSOFT_ENTRA_ID_ISSUER ? { issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER } : {}),
        }),
    },
    {
      id: "google",
      name: "Google",
      enabled: (env) => Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET),
      build: (env) => Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }),
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
            return email ? { id: email, email, name: email } : null;
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
