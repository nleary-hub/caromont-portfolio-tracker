import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { FakeDb } from "./helpers/FakeDb";

// /admin/import, /admin/import/export, /admin/import/template and the import Server Functions, through the real
// modules: an admin (ADMIN_EMAILS) who signed in with a password gets them exactly like a Google admin, without being
// on ALLOWED_EMAILS. Everyone else still gets a 404. next/navigation's redirect and notFound throw so tests see them.
type TestSession = { user: { email: string; passwordAccount?: boolean; mustChangePassword?: boolean } } | null;
const h = vi.hoisted(() => ({ session: null as TestSession, db: null as unknown }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/",
}));
vi.mock("@/auth", () => ({ auth: async () => h.session, signOut: async () => undefined, signIn: async () => undefined, SIGN_IN_PATH: "/signin" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const { default: ImportPage } = await import("@/app/admin/import/page");
const { GET: exportGET } = await import("@/app/admin/import/export/route");
const { GET: templateGET } = await import("@/app/admin/import/template/route");
const { previewImport, commitImport } = await import("@/app/admin/import/actions");
const { ImportPanel } = await import("@/components/ImportPanel");
const { ProjectCsv } = await import("@/lib/import/ProjectCsv");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { ServiceLineAccess } = await import("@/lib/access/ServiceLineAccess");

const NICK = "nick.leary@caromonthealth.org";
const ENV = { ALLOWED_EMAILS: "@example.org", ADMIN_EMAILS: `${NICK} google.admin@elsewhere.org` };
const actor = { changedBy: "someone@example.org" };

class Csv {
  static cell(column: string): string {
    const values: Record<string, string> = { name: "EP import by password admin", owner: "Owner B", status: "On Track", next_milestone: "Kickoff", include_in_report: "yes" };
    return values[column] ?? "";
  }
}

class Sessions {
  static password(email: string, mustChangePassword = false): TestSession {
    return { user: { email, passwordAccount: true, mustChangePassword } };
  }

  static google(email: string): TestSession {
    return { user: { email } };
  }
}

class Surfaces {
  /** Every import surface, each returning (or throwing) what an HTTP caller would get. */
  static all(): Array<[string, () => Promise<unknown>]> {
    return [
      ["/admin/import", () => ImportPage()],
      ["/admin/import/export", () => exportGET()],
      ["/admin/import/template", () => templateGET()],
      ["previewImport", () => previewImport("create", ProjectCsv.templateCsv())],
      ["commitImport", () => commitImport("create", ProjectCsv.templateCsv())],
    ];
  }
}

let fake: FakeDb;
let ep: string;

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  h.session = null;
  ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
  await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "CVPSL project" }, actor, h.db as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("import pages: a password admin (ADMIN_EMAILS, not on ALLOWED_EMAILS) is a full admin", () => {
  it("the page renders the import panel with the admin's viewer for the line switcher and admin menu", async () => {
    h.session = Sessions.password(NICK);
    const el = (await ImportPage()) as ReactElement<{ adminEmail: string; serviceLine: { shortName: string }; switcher: ReactElement<{ viewer: unknown }>; adminMenu: ReactElement<{ viewer: unknown }> }>;
    expect(el.type).toBe(ImportPanel);
    expect(el.props.adminEmail).toBe(NICK);
    expect(el.props.serviceLine.shortName).toBe("CVPSL");
    expect(el.props.switcher.props.viewer).toEqual({ email: NICK, isAdmin: true });
    expect(el.props.adminMenu.props.viewer).toEqual({ email: NICK, isAdmin: true });
  });

  it("the template and export downloads work, and the export follows the admin's active line", async () => {
    h.session = Sessions.password(NICK);
    const template = await templateGET();
    expect(template.status).toBe(200);
    expect(await template.text()).toBe(ProjectCsv.templateCsv());

    const cvpsl = await exportGET();
    expect(cvpsl.status).toBe(200);
    expect(await cvpsl.text()).toContain("CVPSL project");

    // Switched to EP: the export is EP's (empty), not the default line.
    await ServiceLineAccess.setActive({ email: NICK, isAdmin: true }, ep, h.db as never);
    const epCsv = await (await exportGET()).text();
    expect(epCsv).not.toContain("CVPSL project");
    expect((await ImportPage() as ReactElement<{ serviceLine: { shortName: string } }>).props.serviceLine.shortName).toBe("EP");
  });

  it("the import Server Functions preview and commit into the admin's active line, not a 404", async () => {
    h.session = Sessions.password(NICK);
    await ServiceLineAccess.setActive({ email: NICK, isAdmin: true }, ep, h.db as never);
    const csv = `${ProjectCsv.TEMPLATE_COLUMNS.join(",")}\n${ProjectCsv.TEMPLATE_COLUMNS.map((c) => Csv.cell(c)).join(",")}\n`;
    const preview = await previewImport("create", csv);
    expect(preview).toMatchObject({ ok: true, preview: { counts: { rows: 1, ready: 1, errors: 0 }, canCommit: true } });
    const commit = await commitImport("create", csv);
    expect(commit).toEqual({ ok: true, mode: "create", created: 1, skipped: 0 });
    expect(fake.state.projects.find((p) => p.name === "EP import by password admin")?.serviceLineId).toBe(ep);
  });

  it("a password admin still on a temporary password is sent to /set-password, like other admin pages", async () => {
    h.session = Sessions.password(NICK, true);
    for (const [name, call] of Surfaces.all()) await expect(call(), name).rejects.toThrow("REDIRECT /set-password");
  });
});

describe("import pages: non-admins are still blocked (404)", () => {
  const cases: Array<[string, TestSession]> = [
    ["no session", null],
    ["a password account not in ADMIN_EMAILS", Sessions.password("pat.sample@elsewhere.org")],
    ["a password account on ALLOWED_EMAILS but not in ADMIN_EMAILS", Sessions.password("pat.sample@example.org")],
    ["a Google user on ALLOWED_EMAILS but not in ADMIN_EMAILS", Sessions.google("jane.doe@example.org")],
    ["a Google user in ADMIN_EMAILS but not on ALLOWED_EMAILS (unchanged rule)", Sessions.google("google.admin@elsewhere.org")],
    ["a Google session for the password admin's email (Google still needs ALLOWED_EMAILS)", Sessions.google(NICK)],
  ];
  for (const [label, session] of cases) {
    it(label, async () => {
      h.session = session;
      for (const [name, call] of Surfaces.all()) await expect(call(), name).rejects.toThrow("NOT_FOUND");
      expect(fake.state.projects.length).toBe(1);
    });
  }
});
