import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";

// Roles & Permissions PR 2: server enforcement and freeze invisibility (matrix 4.7, L1 to L5). Fictional people only.
const h = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => false } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { ReportsPageData } = await import("@/lib/report/ReportsPageData");
const { ReportArchiveService } = await import("@/lib/services/ReportArchiveService");
const { ReportOptionsService } = await import("@/lib/services/ReportOptionsService");
const { YearEndReportService } = await import("@/lib/services/YearEndReportService");
const { FreezeService } = await import("@/lib/services/FreezeService");
const { DriveCheckService } = await import("@/lib/services/DriveCheckService");
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { OwnerOnlyAudit } = await import("@/lib/permissions/OwnerOnlyAudit");
const { PermissionAssert } = await import("@/lib/permissions/PermissionAssert");
const { PermissionGate } = await import("@/lib/permissions/PermissionGate");
const { AdminMenu } = await import("@/lib/admin/AdminMenu");
const { GRANTABLE_KEYS, HIDDEN_KEYS, VISIBLE_LOCKED_KEYS } = await import("@/lib/permissions/PermissionKeys");
const { OwnerLock, Permissions, roleSeed } = await import("@/lib/permissions");
const reports = await import("@/app/actions/reports");
const archiveRoute = await import("@/app/reports/[id]/[file]/route");
const yearEndRoute = await import("@/app/reports/year-end/[id]/route");
const driveCheck = await import("@/app/api/reports/drive-check/route");

const OWNER_EMAIL = "jordan.pike@example.org";
const OWNER = { email: OWNER_EMAIL, isAdmin: true, name: "Jordan Pike" };
/** Every non-owner: an ADMIN_EMAILS admin, then each stored role (keys from the seeded defaults). */
const person = (roleId: string) => {
  const seed = roleSeed(roleId)!;
  return { email: `${roleId}.person@example.org`, isAdmin: false, name: null, roleId, rank: seed.rank, keys: seed.keys };
};
const NON_OWNERS = [
  ["admin (ADMIN_EMAILS)", { email: "avery.admin@example.org", isAdmin: true, name: "Avery Admin" }],
  ["director", person("director")],
  ["manager", person("manager")],
  ["editor", person("editor")],
  ["viewer", person("viewer")],
] as const;
const REVEALING = [/freez/i, /frozen/i, /snapshot/i, /handoff/i, /delivery/i, /next freeze/i, /stored report archive/i, /saved report archive/i];
const reveals = (text: string) => REVEALING.some((r) => r.test(text));

beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", OWNER_EMAIL);
  vi.stubEnv("ADMIN_EMAILS", `${OWNER_EMAIL},avery.admin@example.org`);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.viewer = null;
});

describe("L1: the /reports loader computes nothing Owner-only for non-owners", () => {
  const OWNER_FIELDS = ["entries", "options", "nextDisplay", "yearEndYears", "yearEnd"];

  it.each(NON_OWNERS)("%s gets only on-demand fields, and the archive, options and year-end services are not called", async (_label, viewer) => {
    const list = vi.spyOn(ReportArchiveService, "list");
    const get = vi.spyOn(ReportOptionsService, "get");
    const years = vi.spyOn(YearEndReportService, "years");
    const yearEndList = vi.spyOn(YearEndReportService, "list");
    const data = await ReportsPageData.load(viewer as never, ServiceLine.defaultScope());
    expect(data).not.toBeNull();
    expect(Object.keys(data!).sort()).toEqual(["canDownloadPdf", "kind"]);
    for (const f of OWNER_FIELDS) expect(Object.keys(data!)).not.toContain(f);
    expect(reveals(JSON.stringify(data))).toBe(false);
    for (const spy of [list, get, years, yearEndList]) expect(spy).not.toHaveBeenCalled();
  });

  it("the Owner still gets the archive, options and year-end data", async () => {
    vi.spyOn(ReportArchiveService, "list").mockResolvedValue([]);
    const get = vi.spyOn(ReportOptionsService, "get").mockResolvedValue({} as never);
    vi.spyOn(YearEndReportService, "years").mockResolvedValue(["FY27"]);
    vi.spyOn(YearEndReportService, "list").mockResolvedValue([]);
    const data = await ReportsPageData.load(OWNER, { ...ServiceLine.defaultScope(), isDefault: false });
    expect(data?.kind).toBe("owner");
    expect(get).toHaveBeenCalled();
    for (const f of OWNER_FIELDS) expect(Object.keys(data!)).toContain(f);
  });

  it("no report.view means no page data at all", async () => {
    expect(await ReportsPageData.load({ ...person("viewer"), keys: [] } as never, ServiceLine.defaultScope())).toBeNull();
  });
});

describe("L2: archive routes answer non-owners with the same 404 as an unknown id", () => {
  const REAL_ID = "11111111-2222-4333-8444-555555555555";
  const RANDOM_ID = "99999999-8888-4777-8666-555555555555";
  const snapshot = async (r: Response) => ({ status: r.status, body: await r.text(), headers: [...r.headers.entries()].sort() });

  it.each(NON_OWNERS)("%s: snapshot PDF, handoff and stored year-end are byte-identical 404s for a real and a random id", async (_label, viewer) => {
    h.viewer = viewer;
    const file = vi.spyOn(ReportArchiveService, "file");
    const yearEndFile = vi.spyOn(YearEndReportService, "file");
    for (const kind of ["pdf", "handoff"]) {
      const real = await snapshot(await archiveRoute.GET(new Request("http://t/"), { params: Promise.resolve({ id: REAL_ID, file: kind }) }));
      const random = await snapshot(await archiveRoute.GET(new Request("http://t/"), { params: Promise.resolve({ id: RANDOM_ID, file: kind }) }));
      expect(real.status).toBe(404);
      expect(real).toEqual(random);
    }
    const real = await snapshot(await yearEndRoute.GET(new Request("http://t/"), { params: Promise.resolve({ id: REAL_ID }) }));
    const random = await snapshot(await yearEndRoute.GET(new Request("http://t/"), { params: Promise.resolve({ id: RANDOM_ID }) }));
    expect(real.status).toBe(404);
    expect(real).toEqual(random);
    expect(file).not.toHaveBeenCalled();
    expect(yearEndFile).not.toHaveBeenCalled();
  });

  it.each(NON_OWNERS)("%s: drive-check is the same 404 and never runs", async (_label, viewer) => {
    h.viewer = viewer;
    const run = vi.spyOn(DriveCheckService, "run");
    const res = await driveCheck.POST();
    expect(res.status).toBe(404);
    expect(reveals(await res.text())).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("L3: Owner-only audit events are invisible to everyone else", () => {
  const events = [
    { kind: "project", field: "status" },
    { kind: "reportOptions", field: "reportOptions.departments" },
    { kind: "reportColors", field: "reportColors.bar" },
    { kind: "freeze", field: "freeze.manual" },
    { kind: "snapshot", field: "snapshot.created" },
    { kind: "delivery", field: "delivery.sent" },
    { kind: "yearEndStored", field: "year_end.stored" },
    { kind: "ownerOnlyDenied", field: "owner_only_denied" },
    { kind: "department", field: "name" },
  ];

  it("a non-owner's list and count have only the non-freeze events", () => {
    const seen = OwnerOnlyAudit.visible(events, false);
    expect(seen.map((e) => e.kind)).toEqual(["project", "department"]);
    expect(seen).toHaveLength(2);
  });

  it("the Owner sees every event", () => {
    expect(OwnerOnlyAudit.visible(events, true)).toHaveLength(events.length);
  });
});

describe("L4: every Owner-only action answers non-owners with exactly \"Not found.\"", () => {
  const form = () => new FormData();
  const ACTIONS: [string, () => Promise<{ message?: string } | null>][] = [
    ["freezeNow", () => reports.freezeNow()],
    ["saveReportOptions", () => reports.saveReportOptions(null, form()) as Promise<{ message?: string } | null>],
    ["saveReportColors", () => reports.saveReportColors(null, form()) as Promise<{ message?: string } | null>],
    ["generateYearEndReport", () => reports.generateYearEndReport("FY27") as Promise<{ message?: string }>],
  ];

  for (const [label, viewer] of NON_OWNERS) {
    it.each(ACTIONS)(`${label}: %s`, async (_name, run) => {
      h.viewer = viewer;
      const freeze = vi.spyOn(FreezeService, "run");
      const generate = vi.spyOn(YearEndReportService, "generate");
      const result = await run();
      expect(result?.message).toBe("Not found.");
      expect(freeze).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    });
  }

  it("the generic answer and the Owner lock text reveal nothing", () => {
    for (const text of [PermissionGate.NOT_FOUND, OwnerLock.MESSAGE]) expect(reveals(text)).toBe(false);
  });

  it("setShowKeyPageForm changes nothing for a non-owner", async () => {
    h.viewer = NON_OWNERS[0][1];
    const update = vi.spyOn(ReportOptionsService, "update");
    await reports.setShowKeyPageForm(new FormData());
    expect(update).not.toHaveBeenCalled();
  });
});

describe("L5: wording visible to non-owners never mentions freezes", () => {
  it("the keys a non-owner can see are the grantable ones plus admin.ai.keys, and none names a freeze surface", () => {
    const visible = [...GRANTABLE_KEYS, ...VISIBLE_LOCKED_KEYS];
    expect(visible).toHaveLength(58);
    for (const k of visible) expect(reveals(k)).toBe(false);
    for (const k of HIDDEN_KEYS) expect(visible).not.toContain(k);
  });

  it.each(NON_OWNERS)("%s: the admin menu has no Owner-only item and no revealing label", (_label, viewer) => {
    const items = AdminMenu.itemsFor(viewer as never) ?? [];
    for (const i of items) {
      expect(AdminMenu.OWNER_ONLY).not.toContain(i.id);
      expect(reveals(`${i.label} ${i.href} ${i.caption ?? ""}`)).toBe(false);
    }
  });

  it("the Owner's menu keeps Report freeze", () => {
    expect(AdminMenu.itemsFor(OWNER)?.map((i) => i.id)).toContain("freeze");
  });
});

describe("server enforcement: keys, rank and line limits", () => {
  it("menu items follow the role's keys", () => {
    expect(AdminMenu.itemsFor(person("viewer") as never)).toBeNull();
    const director = AdminMenu.itemsFor(person("director") as never)!.map((i) => i.id);
    expect(director).toContain("people");
    for (const id of director) {
      const key = AdminMenu.KEYS[id];
      expect(key && Permissions.can(person("director") as never, key)).toBeTruthy();
    }
  });

  it("PermissionAssert.require throws for a missing key and passes with it", () => {
    expect(() => PermissionAssert.require(person("viewer") as Viewer, "people.user.add")).toThrow();
    expect(() => PermissionAssert.require(person("director") as Viewer, "people.view")).not.toThrow();
    expect(() => PermissionAssert.require(null, "people.view")).toThrow();
  });

  it("rank limit: nobody changes the Owner, and only strictly lower accounts", async () => {
    const roles = new Map([["manager.person@example.org", "manager"], ["director.person@example.org", "director"], ["editor.person@example.org", "editor"]]);
    const db = { appUser: { findUnique: async ({ where }: { where: { email: string } }) => ({ roleId: roles.get(where.email) ?? null }) } };
    const director = person("director") as Viewer;
    expect(await PermissionAssert.canManageAccount(director, OWNER_EMAIL, db)).toBe(false);
    expect(await PermissionAssert.canManageAccount(director, "avery.admin@example.org", db)).toBe(false);
    expect(await PermissionAssert.canManageAccount(director, "director.person@example.org", db)).toBe(false);
    expect(await PermissionAssert.canManageAccount(director, "manager.person@example.org", db)).toBe(true);
    expect(await PermissionAssert.canManageAccount(person("manager") as Viewer, "director.person@example.org", db)).toBe(false);
    expect(await PermissionAssert.canManageAccount(OWNER, "avery.admin@example.org", db)).toBe(true);
    expect(await PermissionAssert.canManageAccount({ email: "avery.admin@example.org", isAdmin: true }, OWNER_EMAIL, db)).toBe(false);
  });

  it("a change aimed at the Owner is refused and writes one audit event; allowed or lower-rank refusals write none", async () => {
    const events: { data: Record<string, unknown> }[] = [];
    const db = { appUser: { findUnique: async () => ({ roleId: "director" }) }, roleHistory: { create: async (args: { data: Record<string, unknown> }) => { events.push(args); return args.data; } } };
    const admin = { email: "avery.admin@example.org", isAdmin: true } as Viewer;
    expect(await PermissionAssert.canManageAccount(admin, OWNER_EMAIL, db)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ roleId: "owner", action: PermissionAssert.OWNER_TARGET_REJECTED, actor: "avery.admin@example.org", detail: { target: OWNER_EMAIL } });
    expect(String(events[0].data.id)).toMatch(/^[0-9a-f-]{36}$/);
    // A refusal for an equal or higher non-owner rank and an allowed change record nothing.
    expect(await PermissionAssert.canManageAccount(person("director") as Viewer, "director.person@example.org", db)).toBe(false);
    expect(await PermissionAssert.canManageAccount(OWNER, "avery.admin@example.org", db)).toBe(true);
    expect(events).toHaveLength(1);
    // A failed audit write still refuses.
    const broken = { roleHistory: { create: async () => { throw new Error("db down"); } } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await PermissionAssert.canManageAccount(admin, OWNER_EMAIL, broken)).toBe(false);
    err.mockRestore();
  });

  it("line limit: a Director grants only lines they hold; admins hold every line", async () => {
    const grants = new Set(["director.person@example.org|line-a"]);
    const db = { serviceLineAccessGrant: { findUnique: async ({ where }: { where: { email_serviceLineId: { email: string; serviceLineId: string } } }) => (grants.has(`${where.email_serviceLineId.email}|${where.email_serviceLineId.serviceLineId}`) ? {} : null) } };
    const director = person("director") as Viewer;
    expect(await PermissionAssert.holdsLine(director, "line-a", db as never)).toBe(true);
    expect(await PermissionAssert.holdsLine(director, "line-b", db as never)).toBe(false);
    expect(await PermissionAssert.holdsLine({ email: "avery.admin@example.org", isAdmin: true }, "line-b", db as never)).toBe(true);
  });
});
