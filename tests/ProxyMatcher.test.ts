import { describe, expect, it, vi } from "vitest";
// Next's own matcher compiler, so the anchoring is proved against what Next runs, not assumed.
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";

// Only the matcher is under test; the proxy itself is Auth.js.
vi.mock("@/auth", () => ({ auth: () => undefined }));

const { config } = await import("@/proxy");
/** Next's matcher is a path regex: true = the auth proxy runs (signed-out visitors are sent to /signin). */
const proxied = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);
// Exported at runtime but missing from the published types.
const { getMiddlewareMatchers } = pageStaticInfo as unknown as { getMiddlewareMatchers: (m: string[], c: object) => { regexp: string }[] };
const nextRegex = new RegExp(getMiddlewareMatchers(config.matcher, {})[0].regexp);
/** The same question, answered by the regex Next compiles from the matcher. */
const proxiedByNext = (path: string) => nextRegex.test(path);

const LOGO_FILES = [
  "/brand/favicon.svg",
  "/brand/favicon.ico",
  "/brand/favicon-16.png",
  "/brand/favicon-32.png",
  "/brand/maskable-512.png",
  "/brand/apple-touch-icon-180.png",
  "/brand/app-icon-152.png",
  "/brand/app-icon-167.png",
  "/brand/app-icon-192.png",
  "/brand/app-icon-512.png",
  "/brand/portfolio-tracker-app-icon.svg",
  "/brand/portfolio-tracker-icon-mono.svg",
  "/brand/portfolio-tracker-lockup-mono.svg",
  "/brand/portfolio-tracker-lockup-on-dark.svg",
  "/brand/portfolio-tracker-lockup-on-light.svg",
  "/brand/portfolio-tracker-mark-mono.svg",
  "/brand/portfolio-tracker-mark-on-dark.svg",
  "/brand/portfolio-tracker-mark-on-light.svg",
  "/brand/portfolio-tracker-maskable.svg",
  "/manifest.webmanifest",
];
const STILL_SIGNED_IN = ["/brand", "/brand/", "/brandx", "/brand/sub/page", "/brand/x.json", "/Brand/favicon.svg", "/manifest.webmanifest/x", "/manifestXwebmanifest", "/manifest.webmanifestfoo", "/brand/sub/favicon.svg", "/brand/favicon.svg/", "/brand/favicon.SVG"];
/** Names the tightened stem allows: a word character or hyphen, then word characters, dots or hyphens. */
const TIGHT_PUBLIC = ["/brand/a.svg", "/brand/-.png", "/brand/-mark.png", "/brand/a.b.ico", "/brand/_icon.svg"];
/** A leading dot matched the old [\w.-]+ stem and must stay behind sign-in. */
const LEADING_DOT = ["/brand/.hidden.svg", "/brand/.env.png", "/brand/..secret.ico", "/brand/.svg"];

describe("proxy matcher", () => {
  it("serves the public Inter font without sign-in, so /signin renders in Inter", () => {
    expect(proxied("/fonts/Inter-Variable.ttf")).toBe(false);
    expect(proxied("/signin")).toBe(false);
  });

  it("still protects every app page", () => {
    for (const path of ["/", "/reports", "/admin/people", "/completed", "/fontsy"]) expect(proxied(path), path).toBe(true);
  });

  it("serves the logo files and the manifest without sign-in", () => {
    for (const path of LOGO_FILES) {
      expect(proxied(path), path).toBe(false);
      expect(proxiedByNext(path), `next: ${path}`).toBe(false);
    }
  });

  it("keeps everything else under /brand and near the manifest behind sign-in", () => {
    for (const path of STILL_SIGNED_IN) {
      expect(proxied(path), path).toBe(true);
      expect(proxiedByNext(path), `next: ${path}`).toBe(true);
    }
  });

  it("serves a logo only when its filename matches [\\w-][\\w.-]*", () => {
    for (const path of TIGHT_PUBLIC) {
      expect(proxied(path), path).toBe(false);
      expect(proxiedByNext(path), `next: ${path}`).toBe(false);
    }
    for (const path of LEADING_DOT) {
      expect(proxied(path), path).toBe(true);
      expect(proxiedByNext(path), `next: ${path}`).toBe(true);
    }
  });

  it("covers every file in public/brand", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir("public/brand")).map((f) => `/brand/${f}`).sort();
    expect(files).toEqual(LOGO_FILES.filter((f) => f.startsWith("/brand/")).sort());
  });

  it("exempts exactly main's connector routes, and keeps /oauth/authorize behind sign-in", () => {
    // Byte-identical to origin/main: the logo swap must not widen or narrow the connector segment.
    expect(config.matcher[0]).toContain("api/mcp|oauth/register|oauth/token|\\.well-known/|");
    const PUBLIC_CONNECTOR = ["/api/mcp", "/api/mcp/x", "/oauth/register", "/oauth/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"];
    for (const path of PUBLIC_CONNECTOR) {
      expect(proxied(path), path).toBe(false);
      expect(proxiedByNext(path), `next: ${path}`).toBe(false);
    }
    for (const path of ["/oauth/authorize", "/oauth/authorize?client_id=x", "/oauth", "/oauth/other"]) {
      expect(proxied(path.split("?")[0]), path).toBe(true);
      expect(proxiedByNext(path.split("?")[0]), `next: ${path}`).toBe(true);
    }
  });

  it("adds only the logo files and the manifest as new exemptions versus main", () => {
    const MAIN = "/((?!api/auth|api/cron/|api/share/|api/mcp|oauth/register|oauth/token|\\.well-known/|signin|about$|privacy$|terms$|fonts/|_next/static|_next/image|favicon.ico|robots.txt).*)";
    const added = "brand/[\\w-][\\w.-]*\\.(?:svg|png|ico)$|manifest\\.webmanifest$|";
    expect(config.matcher[0]).toBe(MAIN.replace("fonts/|", `fonts/|${added}`));
  });
});
