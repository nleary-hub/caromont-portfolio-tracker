import NextAuth, { type DefaultSession } from "next-auth";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { SignInPolicy } from "@/lib/auth/SignInPolicy";

export const SIGN_IN_PATH = "/signin";

declare module "next-auth" {
  interface Session {
    user: { isAdmin: boolean } & DefaultSession["user"];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: AuthProviders.fromEnv(),
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
  callbacks: {
    // Access gate: Google only, verified email only, email on ALLOWED_EMAILS or ADMIN_EMAILS.
    signIn({ account, profile }) {
      return SignInPolicy.allowSignIn({ account, profile });
    },
    jwt({ token, profile }) {
      if (profile) token.email = SignInPolicy.verifiedEmail(profile) ?? token.email;
      return token;
    },
    // Admin is derived from ADMIN_EMAILS on every request, never stored in the token.
    session({ session }) {
      session.user.isAdmin = SignInPolicy.isAdmin(session.user?.email);
      return session;
    },
    // Used by the proxy: a session is valid only if its email still has access.
    authorized({ auth }) {
      return SignInPolicy.canAccess(auth?.user?.email);
    },
  },
});
