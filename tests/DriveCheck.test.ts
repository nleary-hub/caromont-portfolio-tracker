import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Admin > Report freeze > Check Drive: admin only (403 otherwise), same Drive settings and client as the freeze,
// saves, reads back and deletes one test file, and never returns a secret. No email, no freeze.
const h = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: async () => h.session, signOut: async () => undefined, signIn: async () => undefined, SIGN_IN_PATH: "/signin" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const { POST } = await import("@/app/api/reports/drive-check/route");
const { DriveCheckService } = await import("@/lib/services/DriveCheckService");

const DRIVE = { GOOGLE_DRIVE_CLIENT_ID: "cid-value", GOOGLE_DRIVE_CLIENT_SECRET: "csecret-value", GOOGLE_DRIVE_REFRESH_TOKEN: "rtoken-value" };
const BASE = { ALLOWED_EMAILS: "@example.org", ADMIN_EMAILS: "admin@example.org" };
const T0 = new Date("2026-09-27T17:00:00Z");

class FakeDrive {
  stored = new Map<string, string>();
  names: string[] = [];
  types: string[] = [];
  calls: string[] = [];
  fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.split("?")[0]}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return json({ files: [{ id: "folder1" }] });
    if (url === "https://www.googleapis.com/drive/v3/files/folder1?fields=name") return json({ name: "Cardiac Status Reports" });
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      const body = Buffer.from(init!.body as Uint8Array).toString("utf8");
      const meta = JSON.parse(/\r\n\r\n(\{[^\r]*\})\r\n/.exec(body)![1]) as { name: string };
      this.names.push(meta.name);
      this.types.push(/--report-[a-z0-9]+\r\nContent-Type: ([^\r]+)\r\n\r\n(?!\{)/.exec(body)?.[1] ?? "?");
      this.stored.set("file1", /Content-Type: text\/plain\r\n\r\n([\s\S]*)\r\n--/.exec(body)![1]);
      return json({ id: "file1", webViewLink: null });
    }
    if (url === "https://www.googleapis.com/drive/v3/files/file1?alt=media") return new Response(this.stored.get("file1") ?? "", { status: 200 });
    if (url === "https://www.googleapis.com/drive/v3/files/file1" && method === "DELETE") {
      this.stored.delete("file1");
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
}

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.session = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Check Drive: admin only", () => {
  it("no session or a non-admin gets 403 and Drive is never called", async () => {
    for (const [k, v] of Object.entries(DRIVE)) vi.stubEnv(k, v);
    const drive = new FakeDrive();
    vi.stubGlobal("fetch", drive.fetch);
    for (const session of [null, { user: { email: "jane@example.org" } }, { user: { email: "admin@elsewhere.org" } }]) {
      h.session = session;
      const res = await POST();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, message: "Not authorized." });
    }
    expect(drive.fetch).not.toHaveBeenCalled();
  });

  it("an admin on a server without Drive settings gets the not-configured message (no Drive call)", async () => {
    h.session = { user: { email: "admin@example.org" } };
    const drive = new FakeDrive();
    vi.stubGlobal("fetch", drive.fetch);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, step: "setup", message: DriveCheckService.NOT_CONFIGURED, detail: DriveCheckService.NOT_CONFIGURED_DETAIL });
    expect(drive.fetch).not.toHaveBeenCalled();
  });

  it("an admin with Drive set up: saves, reads back and deletes one plain text test file; returns the folder and time, no secrets", async () => {
    for (const [k, v] of Object.entries(DRIVE)) vi.stubEnv(k, v);
    h.session = { user: { email: "admin@example.org" } };
    const drive = new FakeDrive();
    vi.stubGlobal("fetch", drive.fetch);
    const res = await POST();
    const body = (await res.json()) as { ok: boolean; message: string; at: string; folder: unknown };
    expect(body.ok).toBe(true);
    expect(body.folder).toEqual({ name: "Cardiac Status Reports", id: "folder1" });
    expect(body.message).toBe(`Drive is working. A test file was saved, read back and removed at ${DriveCheckService.time(new Date(body.at))}.`);
    expect(drive.calls.filter((c) => !c.startsWith("POST https://oauth2"))).toEqual([
      "GET https://www.googleapis.com/drive/v3/files",
      "GET https://www.googleapis.com/drive/v3/files/folder1",
      "POST https://www.googleapis.com/upload/drive/v3/files",
      "GET https://www.googleapis.com/drive/v3/files/file1",
      "DELETE https://www.googleapis.com/drive/v3/files/file1",
    ]);
    expect(drive.names).toHaveLength(1);
    expect(drive.names[0]).toMatch(/^portfolio-drive-setup-test-[0-9T-]+Z\.txt$/);
    expect(drive.types).toEqual(["text/plain"]);
    expect(drive.stored.size).toBe(0);
    expect(JSON.stringify(body)).not.toMatch(/cid-value|csecret-value|rtoken-value|"at":"at"/);
  });
});

describe("DriveCheckService: one message per step", () => {
  const clock = () => T0;
  const failOn = (drive: FakeDrive, match: (url: string, method: string) => boolean, res = () => new Response("backend error", { status: 500 })) =>
    vi.fn(async (url: string, init?: RequestInit) => (match(url, init?.method ?? "GET") ? res() : drive.fetch(url, init)));

  it("copy: helper, success time in ET, file name prefix, no em dashes", () => {
    expect(DriveCheckService.help("Cardiac Status Reports")).toBe("Saves a small test file to Cardiac Status Reports, then removes it. Nothing is frozen or sent.");
    expect(DriveCheckService.time(new Date("2026-09-27T17:42:00Z"))).toBe("1:42 PM");
    expect(DriveCheckService.ok("1:42 PM")).toBe("Drive is working. A test file was saved, read back and removed at 1:42 PM.");
    expect(DriveCheckService.fileName(T0)).toBe("portfolio-drive-setup-test-2026-09-27T17-00-00-000Z.txt");
    const all = [DriveCheckService.help("F"), DriveCheckService.ok("1:42 PM"), DriveCheckService.saveFailed("F"), DriveCheckService.READ_FAILED, DriveCheckService.deleteFailed("F"), DriveCheckService.NOT_CONFIGURED, DriveCheckService.NOT_CONFIGURED_DETAIL];
    for (const s of all) expect(s).not.toContain("\u2014");
  });

  it("success with GOOGLE_DRIVE_FOLDER_ID uses that folder (no lookup) and reports its real name", async () => {
    const drive = new FakeDrive();
    const r = await DriveCheckService.run({ ...DRIVE, GOOGLE_DRIVE_FOLDER_ID: "folder1" }, drive.fetch, clock);
    expect(r).toEqual({ ok: true, message: "Drive is working. A test file was saved, read back and removed at 1:00 PM.", at: T0.toISOString(), folder: { name: "Cardiac Status Reports", id: "folder1" } });
    expect(drive.calls).not.toContain("GET https://www.googleapis.com/drive/v3/files");
    expect(DriveCheckService.folderLabel({ ...DRIVE, GOOGLE_DRIVE_FOLDER_ID: "folder1" })).toBe("the report folder");
    expect(DriveCheckService.folderLabel(DRIVE)).toBe("Cardiac Status Reports");
  });

  it("save: a failed upload (or token/folder) is \"Couldn't save a test file to {folder}.\" with the Drive error underneath", async () => {
    const drive = new FakeDrive();
    const r = await DriveCheckService.run(DRIVE, failOn(drive, (u) => u.startsWith("https://www.googleapis.com/upload/")), clock);
    expect(r).toEqual({ ok: false, step: "save", message: "Couldn't save a test file to Cardiac Status Reports.", detail: expect.stringContaining("(HTTP 500): backend error"), folder: { name: "Cardiac Status Reports", id: "folder1" } });
    const t = await DriveCheckService.run(DRIVE, vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })), clock);
    expect(t).toMatchObject({ ok: false, step: "save", message: "Couldn't save a test file to Cardiac Status Reports.", detail: expect.stringContaining("Token refresh failed (HTTP 400)") });
    expect(JSON.stringify(t)).not.toMatch(/csecret-value|rtoken-value/);
  });

  it("read: \"Saved a test file, but couldn't read it back.\" and the file is still removed; a different body counts too", async () => {
    const drive = new FakeDrive();
    const r = await DriveCheckService.run(DRIVE, failOn(drive, (u) => u.endsWith("alt=media")), clock);
    expect(r).toMatchObject({ ok: false, step: "read", message: "Saved a test file, but couldn't read it back.", detail: "Read back failed (HTTP 500): backend error" });
    expect(drive.stored.size).toBe(0);
    const d2 = new FakeDrive();
    const wrong = await DriveCheckService.run(DRIVE, failOn(d2, (u) => u.endsWith("alt=media"), () => new Response("something else", { status: 200 })), clock);
    expect(wrong).toMatchObject({ ok: false, step: "read", detail: DriveCheckService.MISMATCH_DETAIL });
    expect(d2.stored.size).toBe(0);
  });

  it("delete: \"Drive saves are working, but the test file couldn't be removed. Delete it from {folder}.\"", async () => {
    const drive = new FakeDrive();
    const r = await DriveCheckService.run(DRIVE, failOn(drive, (u, m) => m === "DELETE"), clock);
    expect(r).toMatchObject({ ok: false, step: "delete", message: "Drive saves are working, but the test file couldn't be removed. Delete it from Cardiac Status Reports.", detail: "Delete failed (HTTP 500): backend error" });
  });

  it("not configured: setup step, no Drive call", async () => {
    const f = vi.fn();
    expect(await DriveCheckService.run({}, f, clock)).toEqual({ ok: false, step: "setup", message: DriveCheckService.NOT_CONFIGURED, detail: DriveCheckService.NOT_CONFIGURED_DETAIL });
    expect(f).not.toHaveBeenCalled();
  });

  it("the button: secondary (not blue), next to the folder name, helper under it, no result until run", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { DriveCheckButton } = await import("@/components/DriveCheckButton");
    const html = renderToStaticMarkup(createElement(DriveCheckButton, { folder: "Cardiac Status Reports", help: DriveCheckService.help("Cardiac Status Reports") }));
    expect(html).toMatch(/data-testid="drive-folder">Cardiac Status Reports</);
    expect(html).toMatch(/<button type="button" aria-busy="false" class="([^"]+)" data-testid="drive-check">Check Drive<\/button>/);
    expect(html).not.toMatch(/data-testid="drive-check"[^>]*bg-accent|bg-accent[^"]*" data-testid="drive-check"/);
    expect(html).toContain("Saves a small test file to Cardiac Status Reports, then removes it. Nothing is frozen or sent.");
    expect(html).not.toContain('data-testid="drive-check-result"');
  });
});
