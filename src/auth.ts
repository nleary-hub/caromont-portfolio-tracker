import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { SessionAccess } from "@/lib/auth/SessionAccess";
import { SessionPolicy, type PasswordSessionCheck } from "@/lib/auth/SessionPolicy";
import { SignInGate } from "@/lib/auth/SignInGate";

export const SIGN_IN_PATH = "/signin";

// Loaded on use so the proxy bundle doesn't pull in Prisma for Google sessions.
const passwordSessionCheck: PasswordSessionCheck = async (email, pwdVersion) => {
  const { PasswordSignInService } = await import("@/lib/services/PasswordSignInService");
  return PasswordSignInService.sessionState(email, pwdVersion);
};

const accountActive = async (email: unknown): Promise<boolean> => {
  const { AccountSignInService } = await import("@/lib/services/AccountSignInService");
  return AccountSignInService.isActive(email);
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: AuthProviders.fromEnv(),
  // Cookie lifetime is 7 days (password sessions); Google and other providers keep their 8 hour rule in the jwt callback.
  session: { strategy: "jwt", maxAge: SessionPolicy.COOKIE_MAX_AGE_S },
  pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
  callbacks: {
    // Allowlist gate for Google and the other providers on every sign-in (Google also needs email_verified === true).
    // Google is also allowed for an admin-created account that isn't turned off (ALLOWED_EMAILS OR account).
    // Password sign-ins were checked against the admin-created account in authorize().
    signIn({ user, account, profile }) {
      return SignInGate.allowSignInWithAccounts({ user, account, profile }, accountActive);
    },
    // Sign-in stamps the provider and time; later requests end the session per SessionPolicy (null clears the cookie).
    async jwt({ token, user, account, profile }) {
      if (user) {
        token.email = EmailAllowlist.candidateEmail(user, profile) ?? token.email;
        return SessionPolicy.start(token, account?.provider, user, new Date(), SignInGate.needsAccount({ user, account, profile }));
      }
      return SessionPolicy.continue(token, passwordSessionCheck, new Date(), accountActive);
    },
    session({ session, token }) {
      if (session.user && SessionPolicy.isAccountAccess(token)) session.user.accountAccess = true;
      if (session.user && SessionPolicy.isPassword(token)) {
        session.user.passwordAccount = true;
        session.user.mustChangePassword = token.mustChange === true;
      }
      return session;
    },
    // Used by the proxy on every request. Not allowed: back to /signin ("Your session ended" when a session cookie was
    // sent but is no longer good). A temporary password may only reach /set-password.
    authorized({ auth, request }) {
      if (!SessionAccess.allowed(auth)) {
        const hadSession = request.cookies.getAll().some((c) => /(^|\.)authjs\.session-token/.test(c.name));
        if (!hadSession) return false;
        const url = new URL(SIGN_IN_PATH, request.nextUrl.origin);
        url.searchParams.set("ended", "1");
        url.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
        return NextResponse.redirect(url);
      }
      const onSetPassword = request.nextUrl.pathname === SessionAccess.SET_PASSWORD_PATH;
      if (SessionAccess.mustChangePassword(auth) && !onSetPassword) {
        return NextResponse.redirect(new URL(SessionAccess.SET_PASSWORD_PATH, request.nextUrl.origin));
      }
      return true;
    },
  },
});
