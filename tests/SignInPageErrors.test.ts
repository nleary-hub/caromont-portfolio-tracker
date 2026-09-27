import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// /signin layout of messages (Figma Bro): a wrong password is one red line right above the Email field; only the
// lockout and rate limit (amber) and "Your session ended" (gray) are panels. After a failed attempt the email stays.
const h = vi.hoisted(() => ({ cookie: null as string | null }));
vi.mock("@/auth", () => ({ auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, SIGN_IN_PATH: "/signin" }));
vi.mock("next-auth", () => {
  class AuthError extends Error {
    type = "AuthError";
  }
  class CredentialsSignin extends AuthError {
    code = "credentials";
  }
  return { AuthError, CredentialsSignin };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "signin_email" && h.cookie ? { name, value: h.cookie } : undefined), set: () => {}, delete: () => {} }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { default: SignInPage } = await import("@/app/signin/page");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PasswordCopy } = await import("@/lib/auth/PasswordCopy");

class Page {
  static async html(params: Record<string, string>): Promise<string> {
    return renderToStaticMarkup((await SignInPage({ searchParams: Promise.resolve(params) })) as ReactElement);
  }
}

const esc = (s: string) => s.replace(/'/g, "&#x27;");

beforeEach(() => {
  vi.stubEnv("AUTH_GOOGLE_ID", "gid");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "gsecret");
  vi.stubEnv("DATABASE_URL", "postgres://x");
  vi.stubEnv("ALLOWED_EMAILS", "@example.org");
  h.cookie = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("/signin messages", () => {
  it("wrong password: one red line directly above the Email field, no panel, email kept and password empty", async () => {
    h.cookie = "pat.sample@example.org";
    const html = await Page.html({ error: "CredentialsSignin", code: "invalid" });
    expect(html).not.toMatch(/data-testid="signin-panel-/);
    const line = html.indexOf('data-testid="signin-error"');
    const google = html.indexOf("Sign in with Google");
    const email = html.indexOf(`>${PasswordCopy.EMAIL_LABEL}</span>`);
    expect(line).toBeGreaterThan(google);
    expect(line).toBeLessThan(email);
    expect(html.slice(line, email)).not.toMatch(/<input(?![^>]*type="hidden")/);
    expect(html).toContain(esc(PasswordCopy.INVALID));
    expect(html.match(/data-testid="signin-error"/g)).toHaveLength(1);
    expect(html).toMatch(/name="email"[^>]*value="pat.sample@example.org"/);
    expect(html).not.toMatch(/name="password"[^>]*value="[^"]+"/);
  });

  it("lockout and rate limit are amber panels, and the email is kept", async () => {
    h.cookie = "lee.demo@example.org";
    for (const code of ["locked", "limited"]) {
      const html = await Page.html({ error: "CredentialsSignin", code });
      expect(html).toContain('data-testid="signin-panel-warning"');
      expect(html).not.toContain('data-testid="signin-error"');
      expect(html).toMatch(/name="email"[^>]*value="lee.demo@example.org"/);
    }
  });

  it("session ended is a gray panel with 'Sign in again to keep going.', and a leftover email isn't filled in", async () => {
    h.cookie = "rate.demo@example.org";
    const html = await Page.html({ ended: "1" });
    expect(html).toContain('data-testid="signin-panel-info"');
    expect(html).toContain("Your session ended");
    expect(html).toContain("Sign in again to keep going.");
    expect(html).not.toContain("Please");
    expect(html).not.toMatch(/name="email"[^>]*value="[^"]+"/);
  });

  it("a Google refusal is a red line at the top, not a panel", async () => {
    const html = await Page.html({ error: "AccessDenied" });
    expect(html).not.toMatch(/data-testid="signin-panel-/);
    expect(html.indexOf('data-testid="signin-error"')).toBeLessThan(html.indexOf("Sign in with Google"));
  });
});

describe("/signin for someone whose sign-in is turned off", () => {
  it("Google: the refusal says \"That email can't sign in to this tracker.\" (the same line for every Google refusal)", async () => {
    const html = await Page.html({ error: "AccessDenied" });
    expect(html).toContain(esc("That email can't sign in to this tracker."));
    expect(html).not.toContain("access list");
    expect(html).not.toMatch(/turned off/i);
  });

  it("password: the generic wrong-credentials line, exactly like a wrong password (no hint the account exists)", async () => {
    h.cookie = "kim.test@example.org";
    const html = await Page.html({ error: "CredentialsSignin", code: "invalid" });
    expect(html).toContain(esc(PasswordCopy.INVALID));
    expect(html).not.toMatch(/turned off/i);
  });
});

describe("/signin heartbeat layout", () => {
  it("marks the stage with the message tone so the card can react (error, warning, info, none)", async () => {
    h.cookie = "pat.sample@example.org";
    expect(await Page.html({ error: "CredentialsSignin", code: "invalid" })).toContain('data-state="error"');
    expect(await Page.html({ error: "AccessDenied" })).toContain('data-state="error"');
    expect(await Page.html({ error: "CredentialsSignin", code: "locked" })).toContain('data-state="warning"');
    expect(await Page.html({ ended: "1" })).toContain('data-state="info"');
    expect(await Page.html({})).not.toContain("data-state=");
  });

  it("after a wrong password the cursor goes straight to the password field, never on a plain visit", async () => {
    h.cookie = "pat.sample@example.org";
    expect(await Page.html({ error: "CredentialsSignin", code: "invalid" })).toMatch(/<input[^>]*name="password"[^>]*autofocus|<input[^>]*autofocus[^>]*name="password"/i);
    expect(await Page.html({})).not.toMatch(/autofocus/i);
  });

  it("offers no Microsoft sign-in, even if the old Microsoft env vars are still set", async () => {
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "mid");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "msecret");
    const html = await Page.html({});
    expect(html).toContain("Sign in with Google");
    expect(html).not.toMatch(/Microsoft/);
  });

  it("the backdrop is hidden from screen readers and the headline is the page's only h1", async () => {
    const html = await Page.html({});
    expect(html).toMatch(/class="si-backdrop" aria-hidden="true"/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Every project.");
  });
});
