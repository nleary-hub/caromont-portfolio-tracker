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
const STILL_SIGNED_IN = ["/brand", "/brand/", "/brandx", "/brand/sub/page", "/brand/x.json", "/Brand/favicon.svg", "/manifest.webmanifest/x", "/manifestXwebmanifest", "/manifest.webmanifestfoo", "/brand/sub/favicon.svg"];

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

  it("covers every file in public/brand", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir("public/brand")).map((f) => `/brand/${f}`).sort();
    expect(files).toEqual(LOGO_FILES.filter((f) => f.startsWith("/brand/")).sort());
  });
});
