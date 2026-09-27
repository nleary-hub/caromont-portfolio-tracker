import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// /set-password uses the same frame as /signin (AuthStage); the flow itself is unchanged from PR #43.
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { email: "pat.sample@example.org", passwordAccount: true, mustChangePassword: true } }),
  signIn: async () => undefined,
  signOut: async () => undefined,
  unstable_update: async () => undefined,
  SIGN_IN_PATH: "/signin",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("@/app/actions/password", () => ({ chooseOwnPassword: async () => ({ message: null }) }));

const { default: SetPasswordPage } = await import("@/app/set-password/page");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PasswordCopy } = await import("@/lib/auth/PasswordCopy");

const html = async () => renderToStaticMarkup((await SetPasswordPage({ searchParams: Promise.resolve({}) })) as ReactElement);

describe("/set-password", () => {
  it("sits in the sign-in frame: backdrop, the app headline as the only h1, and the card", async () => {
    const page = await html();
    expect(page).toContain('class="si-stage"');
    expect(page).toMatch(/class="si-backdrop" aria-hidden="true"/);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain("si-card");
  });

  it("keeps the same content: title, intro, email, both fields, the rules and a disabled Save until they're met", async () => {
    const page = await html();
    expect(page).toContain(`<h2 class="type-title text-fg">${PasswordCopy.SET_TITLE}</h2>`);
    expect(page).toContain("pat.sample@example.org");
    expect(page).toContain('data-testid="set-password-form"');
    expect(page).toMatch(/name="password"[^>]*autofocus|autofocus[^>]*name="password"/i);
    expect(page).toContain('name="confirm"');
    expect(page).toContain('data-testid="password-rules"');
    expect(page).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Save and continue/);
  });
});
