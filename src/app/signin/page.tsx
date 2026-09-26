import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { auth, signIn, SIGN_IN_PATH } from "@/auth";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied: "That account is not authorized for this app. Contact the app owner to be added.",
  Configuration: "Sign-in is misconfigured on the server.",
  CredentialsSignin: "Sign-in failed.",
};

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
  if (session?.user && EmailAllowlist.isAllowed(session.user.email)) redirect(redirectTo);

  const providers = AuthProviders.summaries();
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const error = errorCode ? (ERROR_MESSAGES[errorCode] ?? "Sign-in failed.") : null;

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
          {providers.length === 0 && (
            <p className="type-body text-(--status-at-risk-dark-fg)">
              No sign-in providers are configured. Set the Microsoft Entra ID or Google env vars (see README).
            </p>
          )}
          {providers.map((p) =>
            p.id === "dev-login" ? (
              <form
                key={p.id}
                className="space-y-2 border-t border-line pt-3"
                action={async (formData: FormData) => {
                  "use server";
                  await SignInActions.run("dev-login", { email: String(formData.get("email") ?? ""), redirectTo });
                }}
              >
                <label className="block type-caption text-muted" htmlFor="dev-email">
                  Dev login (local only)
                </label>
                <input
                  id="dev-email"
                  name="email"
                  type="email"
                  required
                  className="w-full rounded-control border border-line bg-input px-2 py-1.5 type-table"
                />
                <button className="w-full rounded-control border border-line bg-input px-3 py-2 type-table-strong">
                  Continue
                </button>
              </form>
            ) : (
              <form
                key={p.id}
                action={async () => {
                  "use server";
                  await SignInActions.run(p.id, { redirectTo });
                }}
              >
                <button className="w-full rounded-control bg-accent px-3 py-2 text-white type-table-strong hover:opacity-90">
                  Sign in with {p.name}
                </button>
              </form>
            ),
          )}
        </div>
      </div>
    </main>
  );
}
