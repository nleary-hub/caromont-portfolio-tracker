import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { AdminMenu } from "@/lib/admin/AdminMenu";

// AI and provider keys are Owner-only (CTO order, Oct 22, 2026). This suite ENUMERATES every AI Server Function file
// (src/app/actions/ai*.ts) and every AI route (src/app/api/ai/**/route.ts) from disk and calls every export as a
// non-owner admin, a viewer and a signed-out caller, so a new AI entry point cannot slip through. Fictional people only.
const h = vi.hoisted(() => ({ viewer: null as (Viewer & { name?: string | null }) | null, touched: [] as string[] }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => {
  // Any read or write means the caller got past the gate.
  const client: unknown = new Proxy({}, { get: (_t, k) => { h.touched.push(String(k)); throw new Error(`db touched: ${String(k)}`); } });
  return { Db: { get client() { return client; }, isConfigured: () => true } };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const root = path.resolve(__dirname, "..");
const ACTIONS = readdirSync(path.join(root, "src/app/actions")).filter((f) => /^ai.*\.ts$/.test(f)).sort();
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : f === "route.ts" ? [p] : []; });
const ROUTES = walk(path.join(root, "src/app/api/ai")).map((p) => path.relative(root, p)).sort();

const OWNER = { email: "jordan.pike@example.org", isAdmin: true, name: "Jordan Pike" };
const OTHER_ADMIN = { email: "casey.lund@example.org", isAdmin: true, name: "Casey Lund" };
const VIEWER = { email: "riley.moss@example.org", isAdmin: false, name: "Riley Moss" };
const DENIED = /Not authorized/;

const args = () => {
  const form = new FormData();
  form.set("audio", new Blob(["x"]), "a.webm");
  return [form, "x", "x", "x", "x"] as unknown[];
};

describe("OwnerPolicy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the fixed two-owner set when OWNER_EMAIL is unset or blank, trimmed and case-insensitive, and needs admin", () => {
    vi.stubEnv("OWNER_EMAIL", "");
    expect(OwnerPolicy.ownerEmails()).toEqual([OwnerPolicy.DEFAULT_OWNER_EMAIL, "nicholas.leary@caromonthealth.org"]);
    expect(OwnerPolicy.DEFAULT_OWNER_EMAIL).toMatch(/^[a-z0-9.]+@gmail\.com$/);
    expect(OwnerPolicy.WORK_OWNER_EMAIL).toBe("Nicholas.Leary@CaroMontHealth.org");
    expect(OwnerPolicy.isOwner({ email: OwnerPolicy.DEFAULT_OWNER_EMAIL.toUpperCase(), isAdmin: true })).toBe(true);
    expect(OwnerPolicy.isOwner({ email: "  NICHOLAS.leary@caromonthealth.ORG ", isAdmin: true })).toBe(true);
    expect(OwnerPolicy.isOwner({ email: OwnerPolicy.DEFAULT_OWNER_EMAIL, isAdmin: false })).toBe(false);
    expect(OwnerPolicy.isOwner({ email: OwnerPolicy.WORK_OWNER_EMAIL, isAdmin: false })).toBe(false);
    expect(OwnerPolicy.isOwner({ email: OWNER.email, isAdmin: true })).toBe(false);
    expect(OwnerPolicy.isOwner(null)).toBe(false);
  });

  it("OWNER_EMAIL, when set, replaces the whole set", () => {
    expect(OwnerPolicy.ownerEmails()).toEqual([OWNER.email]);
    expect(OwnerPolicy.isOwner({ email: OwnerPolicy.DEFAULT_OWNER_EMAIL, isAdmin: true })).toBe(false);
    expect(OwnerPolicy.isOwner({ email: OwnerPolicy.WORK_OWNER_EMAIL, isAdmin: true })).toBe(false);
  });

  it("OWNER_EMAIL overrides (the test servers); other admins are never the Owner", () => {
    expect(OwnerPolicy.isOwner(OWNER)).toBe(true);
    expect(OwnerPolicy.isOwner(OTHER_ADMIN)).toBe(false);
    expect(OwnerPolicy.isOwner(VIEWER)).toBe(false);
  });
});

describe("every AI entry point uses the one Owner gate", () => {
  it("finds the AI Server Function files and routes", () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(10);
    expect(ACTIONS).toEqual(expect.arrayContaining(["ai.ts", "aiKeys.ts", "aiTools.ts", "aiActions.ts", "aiPlaybook.ts", "aiReview.ts"]));
    expect(ROUTES).toContain("src/app/api/ai/voice/connect/route.ts");
  });

  it("each AI file and AI page resolves its viewer through OwnerGate, never CurrentViewer directly", () => {
    const pages = ["src/app/ai-tools/page.tsx", "src/app/playbook/page.tsx", "src/app/admin/ai/page.tsx"];
    for (const f of [...ACTIONS.map((a) => `src/app/actions/${a}`), ...ROUTES, ...pages]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).toContain("OwnerGate.ownerViewer()");
      expect(src, f).not.toContain("CurrentViewer");
    }
  });

  it("no other Server Function file or API route calls an AI service (cron retention excepted: no session, no provider call)", () => {
    const files = [...walk(path.join(root, "src/app/api")).map((p) => path.relative(root, p)), ...readdirSync(path.join(root, "src/app/actions")).map((f) => `src/app/actions/${f}`)];
    const outside = files.filter((f) => !ACTIONS.some((a) => f.endsWith(`/actions/${a}`)) && !ROUTES.includes(f) && f !== "src/app/api/cron/ai-retention/route.ts");
    for (const f of outside) expect(readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/@\/lib\/ai\/|services\/Ai[A-Z]/);
  });

  it("the dashboard, templates and dependencies pages show AI controls to the Owner only; the menu hides AI for others", () => {
    expect(readFileSync(path.join(root, "src/app/page.tsx"), "utf8")).toContain("Boolean(admin) && OwnerPolicy.isOwner(viewer) && Db.isConfigured()");
    expect(readFileSync(path.join(root, "src/app/admin/templates/page.tsx"), "utf8")).toContain("configured && OwnerPolicy.isOwner(viewer) ? await templateAiNote()");
    expect(readFileSync(path.join(root, "src/app/admin/dependencies/page.tsx"), "utf8")).toContain("const aiOn = OwnerPolicy.isOwner(viewer) ?");
  });
});

describe.each([
  ["a non-owner admin", OTHER_ADMIN],
  ["a viewer", VIEWER],
  ["a signed-out caller", null],
])("%s", (_label, viewer) => {
  afterEach(() => {
    h.touched = [];
  });

  it.each(ACTIONS)("is refused by every export of src/app/actions/%s, before any database access", async (file) => {
    const mod = (await import(`@/app/actions/${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function") as [string, (...a: unknown[]) => Promise<unknown>][];
    expect(fns.length).toBeGreaterThan(0);
    for (const [name, fn] of fns) {
      h.viewer = viewer;
      h.touched = [];
      const r = (await fn(...args())) as object | boolean | null | undefined;
      expect(h.touched, `${file} ${name}`).toEqual([]);
      if (r == null || typeof r !== "object") {
        expect(r, `${file} ${name}`).not.toBe(true);
        continue;
      }
      expect((r as { ok?: unknown }).ok, `${file} ${name}`).not.toBe(true);
      // The voice tool runner wraps its answer for the model.
      if ("output" in r) expect(String((r as { output: unknown }).output), `${file} ${name}`).toMatch(DENIED);
    }
  });

  it.each(ROUTES)("gets 403 from every handler of %s", async (file) => {
    const mod = (await import(`@/${file.replace(/^src\//, "").replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    const handlers = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    for (const m of handlers) {
      h.viewer = viewer;
      const res = (await (mod[m] as (r: Request) => Promise<Response>)(new Request("http://127.0.0.1/x", { method: m, body: m === "GET" ? undefined : "{}" }))) as Response;
      expect(res.status, `${file} ${m}`).toBe(403);
      expect(h.touched).toEqual([]);
    }
  });
});

describe("the Owner", () => {
  it.each(ACTIONS)("gets past the gate in src/app/actions/%s", async (file) => {
    const mod = (await import(`@/app/actions/${file.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
    let reached = 0;
    for (const [, fn] of Object.entries(mod).filter(([, v]) => typeof v === "function") as [string, (...a: unknown[]) => Promise<unknown>][]) {
      h.viewer = OWNER;
      h.touched = [];
      const r = await Promise.resolve(fn(...args())).catch(() => undefined);
      // Past the gate: it reached the database, or answered with something other than "Not authorized.".
      if (h.touched.length || (r != null && !DENIED.test(JSON.stringify(r)))) reached++;
    }
    expect(reached).toBeGreaterThan(0);
  });

  it("gets past the gate on the voice connect route", async () => {
    h.viewer = OWNER;
    h.touched = [];
    const { POST } = await import("@/app/api/ai/voice/connect/route");
    const res = await POST(new Request("http://127.0.0.1/x", { method: "POST", body: "{}" })).catch(() => null);
    expect(res?.status === 403 && h.touched.length === 0).toBe(false);
  });
  it("gets past the gate on the model picker route", async () => {
    h.viewer = OWNER;
    h.touched = [];
    const { POST } = await import("@/app/api/ai/models/pick/route");
    const res = await POST(new Request("http://127.0.0.1/x", { method: "POST", body: "{}", headers: { "sec-fetch-site": "same-origin" } })).catch(() => null);
    expect(res?.status === 403 && h.touched.length === 0).toBe(false);
  });
});

describe("the built-in two-owner set (OWNER_EMAIL unset): AI and provider keys", () => {
  afterEach(() => { vi.unstubAllEnvs(); h.touched = []; });
  const keysFns = async () => Object.entries((await import("@/app/actions/aiKeys")) as Record<string, unknown>).filter(([, v]) => typeof v === "function") as [string, (...a: unknown[]) => Promise<unknown>][];
  const NICK_WORK = { email: "Nicholas.Leary@CaroMontHealth.org", isAdmin: true, name: "Nick" };

  it.each([
    ["the existing admin account", () => ({ email: OwnerPolicy.DEFAULT_OWNER_EMAIL, isAdmin: true, name: "Nick" })],
    ["the CaroMont work address", () => NICK_WORK],
    ["the work address in mixed case", () => ({ ...NICK_WORK, email: " nICHOLAS.LEARY@caromonthealth.Org " })],
  ])("%s gets AI (gate and menu) and reaches the provider-key actions", async (_l, who) => {
    vi.stubEnv("OWNER_EMAIL", "");
    h.viewer = who();
    expect(await OwnerGate.ownerViewer()).not.toBeNull();
    expect(AdminMenu.itemsFor(h.viewer)?.map((i) => i.id)).toEqual(expect.arrayContaining(["ai-tools", "ai-settings"]));
    let reached = 0;
    for (const [, fn] of await keysFns()) {
      h.touched = [];
      const r = await Promise.resolve(fn(...args())).catch(() => undefined);
      if (h.touched.length || (r != null && !DENIED.test(JSON.stringify(r)))) reached++;
    }
    expect(reached).toBeGreaterThan(0);
  });

  it.each([["a non-owner admin", OTHER_ADMIN], ["a viewer", VIEWER]])("%s gets no AI and no keys", async (_l, who) => {
    vi.stubEnv("OWNER_EMAIL", "");
    h.viewer = who;
    expect(await OwnerGate.ownerViewer()).toBeNull();
    expect((AdminMenu.itemsFor(who) ?? []).map((i) => i.id)).not.toEqual(expect.arrayContaining(["ai-settings"]));
    expect((AdminMenu.itemsFor(who) ?? []).map((i) => i.id)).not.toContain("ai-tools");
    for (const [name, fn] of await keysFns()) {
      h.touched = [];
      const r = (await fn(...args())) as { ok?: unknown } | null | undefined;
      expect(h.touched, name).toEqual([]);
      expect(r && typeof r === "object" ? r.ok : r, name).not.toBe(true);
    }
  });
});
