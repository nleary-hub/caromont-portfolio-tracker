import NextAuth from "next-auth";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

export const SIGN_IN_PATH = "/signin";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: AuthProviders.fromEnv(),
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
  callbacks: {
    // Allowlist gate: runs for every provider on every sign-in.
    signIn({ user, profile }) {
      return EmailAllowlist.isAllowed(EmailAllowlist.candidateEmail(user, profile));
    },
    jwt({ token, user, profile }) {
      if (user) token.email = EmailAllowlist.candidateEmail(user, profile) ?? token.email;
      return token;
    },
    // Used by the proxy: a session is valid only if its email is (still) allowlisted.
    authorized({ auth }) {
      return EmailAllowlist.isAllowed(auth?.user?.email);
    },
  },
});
