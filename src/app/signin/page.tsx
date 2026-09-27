import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, CredentialsSignin } from "next-auth";
import { auth, signIn, SIGN_IN_PATH } from "@/auth";
import { AuthProviders } from "@/lib/auth/AuthProviders";
import { SessionAccess } from "@/lib/auth/SessionAccess";
import { PasswordField } from "@/components/PasswordField";
import { AuthMessageIcon, AuthStage } from "@/components/AuthStage";
import { SignInButton } from "@/components/SignInButton";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { SessionPolicy } from "@/lib/auth/SessionPolicy";
import { SignInMessages } from "@/lib/auth/SignInMessages";

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

/**
 * After a failed password attempt (wrong password, lockout, rate limit) the email stays filled in and only the password
 * is cleared. The email rides in a short-lived, httpOnly cookie scoped to /signin, not in the URL.
 */
class RememberedEmail {
  static readonly COOKIE = "signin_email";
  static readonly MAX_AGE_S = 10 * 60;

  static async set(email: string): Promise<void> {
    const store = await cookies();
    const value = email.trim().slice(0, 254);
    if (!value) return;
    store.set(RememberedEmail.COOKIE, value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: SIGN_IN_PATH, maxAge: RememberedEmail.MAX_AGE_S });
  }

  static async clear(): Promise<void> {
    (await cookies()).delete({ name: RememberedEmail.COOKIE, path: SIGN_IN_PATH });
  }

  static async read(): Promise<string> {
    return (await cookies()).get(RememberedEmail.COOKIE)?.value ?? "";
  }
}

class SignInActions {
  /**
   * Run an Auth.js sign-in; map AuthError (e.g. allowlist denial) to the sign-in page instead of a 500. Credentials
   * errors add their code ("invalid" or "locked", see AuthProviders), which never says why a password failed.
   */
  static async run(provider: string, options: Record<string, string>): Promise<void> {
    const isPassword = provider === SessionPolicy.PASSWORD_PROVIDER;
    if (isPassword) await RememberedEmail.clear();
    try {
      await signIn(provider, options);
    } catch (error) {
      if (error instanceof AuthError) {
        if (isPassword && error instanceof CredentialsSignin) await RememberedEmail.set(options.email ?? "");
        const code = error instanceof CredentialsSignin ? `&code=${encodeURIComponent(error.code)}` : "";
        redirect(`${SIGN_IN_PATH}?error=${encodeURIComponent(error.type)}${code}`);
      }
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
  if (SessionAccess.allowed(session)) redirect(SessionAccess.mustChangePassword(session) ? SessionAccess.SET_PASSWORD_PATH : redirectTo);

  const providers = AuthProviders.summaries();
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const detail = Array.isArray(params.code) ? params.code[0] : params.code;
  const message = SignInMessages.panel(errorCode, detail, params.ended === "1");
  const panel = message && message.tone !== "error" ? message : null;
  const errorLine = message?.tone === "error" ? message.body : null;
  const passwordError = errorLine && errorCode === "CredentialsSignin" ? errorLine : null;
  const topError = errorLine && !passwordError ? errorLine : null;
  const oauth = providers.filter((p) => p.id !== "dev-login" && p.id !== SessionPolicy.PASSWORD_PROVIDER);
  const password = providers.some((p) => p.id === SessionPolicy.PASSWORD_PROVIDER);
  const devLogin = providers.some((p) => p.id === "dev-login");
  // Only right after a failed password attempt (its redirect carries the credentials error), never on a plain visit.
  const rememberedEmail = password && errorCode === "CredentialsSignin" ? await RememberedEmail.read() : "";

  // The card motion (AuthStage): error = one shake and a red flash, warning = amber border and slower rings.
  const state = errorLine ? "error" : (panel?.tone ?? undefined);

  return (
    <AuthStage state={state}>
      {/*
        Amber panels for the lockout and rate limit, a gray panel for "Your session ended". Errors are one line
        of red text, not a panel: a wrong password sits right above the Email field.
      */}
      {panel && (
        <div role={panel.tone === "info" ? "status" : "alert"} data-testid={`signin-panel-${panel.tone}`} className={`si-notice si-notice-${panel.tone}`}>
          <AuthMessageIcon kind={panel.tone === "info" ? "info" : "clock"} />
          <div>
            {panel.title && <p className="si-notice-title">{panel.title}</p>}
            <p className="si-notice-body">{panel.body}</p>
          </div>
        </div>
      )}
      {(topError || (passwordError && !password)) && (
        <p role="alert" data-testid="signin-error" className="si-error">
          <AuthMessageIcon kind="alert" />
          <span>{topError ?? passwordError}</span>
        </p>
      )}

      <div className="space-y-3">
        {providers.length === 0 && (
          <p className="type-body text-(--status-at-risk-dark-fg)">No sign-in providers are configured. Set the Google env vars (see README).</p>
        )}
        {oauth.map((p) => (
          <form
            key={p.id}
            className="si-reveal si-d1"
            action={async () => {
              "use server";
              await SignInActions.run(p.id, { redirectTo });
            }}
          >
            <SignInButton label={`Sign in with ${p.name}`} variant="primary" />
          </form>
        ))}
        {password && (
          <>
            {oauth.length > 0 && (
              <div className="si-divider si-reveal si-d2" aria-hidden="true">
                {PasswordCopy.DIVIDER}
              </div>
            )}
            <form
              className="si-reveal si-d3 space-y-3"
              data-testid="password-signin"
              action={async (formData: FormData) => {
                "use server";
                // Via /set-password, which sends anyone not on a temporary password on to redirectTo. A sign-in's own
                // redirect renders its target without the proxy, so this keeps the address bar on /set-password.
                await SignInActions.run(SessionPolicy.PASSWORD_PROVIDER, {
                  email: String(formData.get("email") ?? ""),
                  password: String(formData.get("password") ?? ""),
                  redirectTo: `${SessionAccess.SET_PASSWORD_PATH}?next=${encodeURIComponent(redirectTo)}`,
                });
              }}
            >
              {passwordError && (
                <p role="alert" id="signin-password-error" data-testid="signin-error" className="si-error">
                  <AuthMessageIcon kind="alert" />
                  <span>{passwordError}</span>
                </p>
              )}
              <label className="block space-y-1">
                <span className="block type-caption text-muted">{PasswordCopy.EMAIL_LABEL}</span>
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  defaultValue={rememberedEmail}
                  aria-describedby={passwordError ? "signin-password-error" : undefined}
                  aria-invalid={passwordError ? true : undefined}
                  required
                  className="si-input"
                />
              </label>
              <label className="block space-y-1">
                <span className="block type-caption text-muted">{PasswordCopy.PASSWORD_LABEL}</span>
                {/* After a wrong password the email stays, so put the cursor straight in the password field. */}
                <PasswordField name="password" autoComplete="current-password" autoFocus={Boolean(passwordError)} />
              </label>
              <SignInButton label={PasswordCopy.SUBMIT} variant="secondary" />
              <p className="type-caption text-muted">{PasswordCopy.HELP}</p>
            </form>
          </>
        )}
        {devLogin && (
          <form
            className="space-y-2 border-t border-line pt-3"
            action={async (formData: FormData) => {
              "use server";
              await SignInActions.run("dev-login", { email: String(formData.get("email") ?? ""), redirectTo });
            }}
          >
            <label className="block type-caption text-muted" htmlFor="dev-email">
              Dev login (local only)
            </label>
            <input id="dev-email" name="email" type="email" required className="si-input" />
            <SignInButton label="Continue" variant="secondary" />
          </form>
        )}
      </div>
    </AuthStage>
  );
}
