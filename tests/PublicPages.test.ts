import { describe, expect, it, vi } from "vitest";

// Google won't publish the OAuth app (so the Drive refresh token stops expiring every 7 days) without a public home
// page, privacy policy and terms of service. These pin that the three pages render signed out and stay public.
vi.mock("@/auth", () => ({ auth: () => undefined, SIGN_IN_PATH: "/signin" }));

const { config } = await import("@/proxy");
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: About } = await import("@/app/about/page");
const { default: Privacy } = await import("@/app/privacy/page");
const { default: Terms } = await import("@/app/terms/page");
const { PublicPages } = await import("@/lib/legal/PublicPages");

const proxied = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe("public About, Privacy and Terms pages", () => {
  it("the auth proxy skips exactly /about, /privacy and /terms", () => {
    for (const path of PublicPages.PATHS) expect(proxied(path), path).toBe(false);
    for (const path of ["/aboutx", "/privacy-settings", "/terms/x", "/reports", "/"]) expect(proxied(path), path).toBe(true);
  });

  it("each page renders with no session and links to the others and to sign-in", () => {
    for (const [Page, page] of [[About, PublicPages.ABOUT], [Privacy, PublicPages.PRIVACY], [Terms, PublicPages.TERMS]] as const) {
      const html = renderToStaticMarkup(Page());
      expect(html).toContain(`data-testid="public-page-${page.path.slice(1)}"`);
      expect(html).toContain(page.title);
      expect(html).toContain('href="/signin"');
      for (const other of PublicPages.ALL.filter((p) => p !== page)) expect(html).toContain(`href="${other.path}"`);
    }
  });

  it("the privacy policy says what Google data the app uses, and makes no compliance claims", () => {
    const text = JSON.stringify(PublicPages.PRIVACY);
    expect(text).toContain("only lets the app create files and use the files it created");
    expect(text).toContain("isn't sold, used for advertising, or used to train AI models");
    expect(text).not.toMatch(/HIPAA|compliant|complies/i);
  });
});
