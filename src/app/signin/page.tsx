import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn, SIGN_IN_PATH } from "@/auth";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { SignInPolicy } from "@/lib/auth/SignInPolicy";

/** Deliberately generic: never reveal which check failed or what the lists contain. */
class SignInMessages {
  static readonly ACCESS_DENIED = "This account is not on the access list.";
  static readonly GENERIC = "Sign-in failed. Please try again.";

  static forCode(code: string | undefined): string | null {
    if (!code) return null;
    return code === "AccessDenied" ? SignInMessages.ACCESS_DENIED : SignInMessages.GENERIC;
  }
}

class SafeRedirect {
  /** Reduce any callback URL to a same-site path (drops scheme/host, so it can never leave the app). */
  static target(value: string | string[] | undefined): string {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v) return "/";
    try {
      const url = new URL(v, "http://local");
      const path = url.pathname + url.search;
      return path.startsWith("/signin") || path.startsWith("/api/auth") ? "/" : path;
    } catch {
      return "/";
    }
  }
}

class SignInActions {
  /** Run an Auth.js sign-in; map AuthError (e.g. allowlist denial) to the sign-in page instead of a 500. */
  static async run(provider: string, options: Record<string, string>): Promise<void> {
    try {
      await signIn(provider, options);
    } catch (error) {
      if (error instanceof AuthError) redirect(`${SIGN_IN_PATH}?error=${encodeURIComponent(error.type)}`);
      throw error; // includes Next.js redirect "errors", which must propagate
    }
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const redirectTo = SafeRedirect.target(params.callbackUrl);
  const session = await auth();
  if (session?.user && SignInPolicy.canAccess(session.user.email)) redirect(redirectTo);

  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const error = SignInMessages.forCode(errorCode);
  const configured = AuthProviders.isGoogleConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-6 shadow-lg">
        <h1 className="type-title">Service Line Portfolio Tracker</h1>
        <p className="mt-1 type-caption text-muted">Cardiac Procedure Services · internal use only</p>

        {error && (
          <p role="alert" className="mt-4 rounded-control border border-line bg-(--status-off-track-dark-bg) px-3 py-2 type-body text-(--status-off-track-dark-fg)">
            {error}
          </p>
        )}

        <div className="mt-6 space-y-3">
          {!configured && (
            <p className="type-body text-(--status-at-risk-dark-fg)">
              Google sign-in is not configured. Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET (see README).
            </p>
          )}
          <form
            action={async () => {
              "use server";
              await SignInActions.run(SignInPolicy.PROVIDER_ID, { redirectTo });
            }}
          >
            <button
              disabled={!configured}
              className="w-full rounded-control bg-accent px-3 py-2 text-white type-table-strong hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sign in with Google
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
