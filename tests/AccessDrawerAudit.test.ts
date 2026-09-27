import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { PasswordFakeDb } from "./helpers/PasswordFakeDb";
import { Factory } from "./helpers/factories";

// fix/access-drawer-audit: Access grid method tags, same-name rows, row menu header and temp-password dialog; the
// edit drawer without the leaked People block; Recent changes labels and plain OLD / NEW summaries; Report colors
// preview and default labels.
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
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
vi.mock("@/auth", () => ({ auth: async () => null, signOut: async () => undefined, signIn: async () => undefined, SIGN_IN_PATH: "/signin" }));

const { renderToStaticMarkup } = await import("react-dom/server");
const { AccessAdmin } = await import("@/components/AccessAdmin");
const { AccountRowMenu, PasswordTags, TempPasswordDialog } = await import("@/components/AccessAccountControls");
const { PasswordCopy } = await import("@/lib/auth/PasswordCopy");
const { SignInMethods } = await import("@/lib/auth/SignInMethods");
const { UserAccountService } = await import("@/lib/services/UserAccountService");
const { AuditText } = await import("@/lib/admin/AuditText");
const { AuditCopy } = await import("@/lib/admin/AuditCopy");
const { ReportColorScheme } = await import("@/lib/report/ReportColorScheme");

const ROOT = path.resolve(__dirname, "..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const GMAIL = "nleary@gmail.com";
const WORK = "nicholas.leary@caromonthealth.org";
const ENV = { ALLOWED_EMAILS: `${GMAIL} ${WORK}`, ADMIN_EMAILS: `${GMAIL} ${WORK}` };
const S = (state: "none" | "active" | "mustChange", extra: { off?: boolean; locked?: boolean } = {}) => ({ state, off: false, locked: false, ...extra });
const tagsOf = (html: string) => [...html.matchAll(/data-password-tag="([^"]+)"/g)].map((m) => m[1]);
const grid = (admins: Array<{ email: string; name: string }>, users: Array<{ email: string; name: string }> = []) => ({
  lines: [{ id: "L1", shortName: "CVPSL", name: "Cardiovascular & Pulmonary Service Line", departments: [] }],
  admins: admins.map((a) => ({ ...a, isAdmin: true, lineIds: [], limits: {} })),
  users: users.map((u) => ({ ...u, isAdmin: false, lineIds: ["L1"], limits: {} })),
  canAdd: true,
});

afterEach(() => {
  h.viewer = null;
  h.db = null;
});

describe("Access grid: sign-in method tags", () => {
  it("lists every method that works, Google then Password, side by side in one group", () => {
    expect(SignInMethods.of(S("active"), true)).toEqual(["google", "password"]);
    expect(SignInMethods.of(S("mustChange"), true)).toEqual(["google", "password"]);
    expect(SignInMethods.of(S("none"), true)).toEqual(["google"]);
    expect(SignInMethods.of(S("active"), false)).toEqual(["password"]);
    // Without Google information, the old rule: Google only for accounts with no password.
    expect(SignInMethods.of(S("none"))).toEqual(["google"]);
    expect(SignInMethods.of(S("active"))).toEqual(["password"]);
    const html = renderToStaticMarkup(createElement(PasswordTags, { status: S("active"), google: true }));
    expect(tagsOf(html)).toEqual(["google", "password"]);
    expect(html).toMatch(/data-testid="signin-methods"[^>]*>(<span[^>]*data-password-tag="google">Google<\/span>)(<span[^>]*data-password-tag="password">Password<\/span>)<\/span>/);
  });

  it("Must change password is its own amber tag after a visible gap, never a method", () => {
    const html = renderToStaticMarkup(createElement(PasswordTags, { status: S("mustChange"), google: true }));
    expect(tagsOf(html)).toEqual(["google", "password", "must-change"]);
    const must = /<span class="([^"]+)" title="[^"]*" data-password-tag="must-change">([^<]+)</.exec(html)!;
    expect(must[2]).toBe("Must change password");
    // The app's amber warning: the same tokens as the Start date "Default" tag, nothing like the blue method tags.
    const defaultTag = src("src/components/StartDateDefaultTag.tsx");
    expect(defaultTag).toContain("var(--status-at-risk-dark-bg)");
    expect(defaultTag).toContain("var(--status-at-risk-dark-fg)");
    expect(must[1]).toContain("bg-(--status-at-risk-dark-bg)");
    expect(must[1]).toContain("text-(--status-at-risk-dark-fg)");
    expect(must[1]).not.toMatch(/flag-changed|on-hold/);
    const google = /<span class="([^"]+)" title="[^"]*" data-password-tag="google">/.exec(html)![1];
    expect(google).toContain("on-hold");
    expect(google).not.toContain("at-risk");
    expect(must[1]).toContain("ml-2");
    // Outside the methods group.
    const group = /data-testid="signin-methods"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(html)![1];
    expect(group).not.toContain("must-change");
    // Off and Locked follow the same way; the gap goes on the first state tag only.
    const off = renderToStaticMarkup(createElement(PasswordTags, { status: S("active", { off: true, locked: true }), google: false }));
    expect(tagsOf(off)).toEqual(["password", "off", "locked"]);
    expect(/data-password-tag="locked"/.exec(off) && /class="([^"]+)" title="[^"]*" data-password-tag="locked"/.exec(off)![1]).not.toContain("ml-2");
  });

  it("googleSignIn: ALLOWED_EMAILS or an admin-created account, as the sign-in gate decides", async () => {
    const db = new PasswordFakeDb();
    await db.appUser.create({ data: { email: "added@elsewhere.org", name: "Added", addedBy: GMAIL } });
    await db.appUser.create({ data: { email: "firstsignin@elsewhere.org", name: "First", addedBy: null } });
    const r = await UserAccountService.googleSignIn({ ...Factory.ADMIN }, [WORK, "added@elsewhere.org", "firstsignin@elsewhere.org"], db as never, ENV);
    expect(r).toEqual({ [WORK]: true, "added@elsewhere.org": true, "firstsignin@elsewhere.org": false });
    await expect(UserAccountService.googleSignIn({ email: "x@example.org", isAdmin: false }, [WORK], db as never, ENV)).rejects.toThrow();
  });
});

describe("Access grid: every row uses the same three-line layout", () => {
  const html = renderToStaticMarkup(
    createElement(AccessAdmin, {
      grid: grid(
        [
          { email: GMAIL, name: "Nicholas Leary" },
          { email: WORK, name: "Nicholas Leary" },
        ],
        [{ email: "pat.lee@caromonthealth.org", name: "Pat Lee" }],
      ),
      passwords: { [GMAIL]: S("none"), [WORK]: S("mustChange"), "pat.lee@caromonthealth.org": S("active") },
      google: { [GMAIL]: true, [WORK]: true, "pat.lee@caromonthealth.org": true },
    }),
  );
  const rows = Object.fromEntries([...html.matchAll(/<tr data-access-row="([^"]+)"[\s\S]*?<\/tr>/g)].map((m) => [m[1], m[0]]));
  const NAMES: Record<string, string> = { [GMAIL]: "Nicholas Leary", [WORK]: "Nicholas Leary", "pat.lee@caromonthealth.org": "Pat Lee" };

  it("email bold (line 1), name muted (line 2), tags on their own line (line 3), for admins and users alike", () => {
    for (const [email, name] of Object.entries(NAMES)) {
      const row = rows[email];
      const m = /data-testid="access-identity"><span class="([^"]+)">([^<]+)<\/span><span class="([^"]+)">([^<]+)<\/span><\/span>/.exec(row)!;
      expect(m[2], email).toBe(email);
      expect(m[1]).toContain("type-table-strong");
      expect(m[4]).toBe(name);
      expect(m[3]).toContain("text-muted");
      // The tags line comes after the identity block, as its own line inside the person column.
      const person = /data-testid="access-person">([\s\S]*)$/.exec(row)![1];
      expect(person.indexOf("access-identity")).toBeLessThan(person.indexOf('data-testid="access-tags"'));
      const identity = /data-testid="access-identity">[\s\S]*?<\/span><\/span>/.exec(person)![0];
      expect(identity).not.toContain("data-password-tag");
      const tagsLine = /data-testid="access-tags">([\s\S]*?)<\/td>/.exec(row)![1];
      expect(tagsOf(tagsLine).length).toBeGreaterThan(0);
    }
    // The Gmail row no longer puts Google next to the email.
    expect(tagsOf(/data-testid="access-tags">([\s\S]*?)<\/td>/.exec(rows[GMAIL])![1])).toEqual(["google"]);
    expect(tagsOf(rows[WORK])).toEqual(["google", "password", "must-change"]);
    // Users keep the expand button, now around the email and name.
    expect(rows["pat.lee@caromonthealth.org"]).toMatch(/data-testid="access-name"><span class="[^"]*" data-testid="access-identity">/);
  });
});

describe("Access grid: row menu and temporary password dialog", () => {
  it("the ⋯ menu header shows the account's email in bold", () => {
    const html = renderToStaticMarkup(createElement(AccountRowMenu, { name: "Nicholas Leary", email: WORK, status: S("none"), initialOpen: true, onResult: () => {} }));
    const m = /<li role="presentation" class="([^"]+)" title="([^"]+)" data-testid="access-row-email">([^<]+)<\/li>/.exec(html)!;
    expect(m[3]).toBe(WORK);
    expect(m[1]).toContain("type-table-strong");
    // First thing in the menu, before the items.
    expect(html.indexOf("access-row-email")).toBeLessThan(html.indexOf('role="menuitem"'));
    // The item that opens the temporary password dialog is "Create temporary password" for every account.
    for (const state of ["none", "active", "mustChange"] as const) {
      const items = [...renderToStaticMarkup(createElement(AccountRowMenu, { name: "N", email: WORK, status: S(state), initialOpen: true, onResult: () => {} })).matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((x) => x[1]);
      expect(items[0]).toBe("Create temporary password");
      expect(items).not.toContain("Reset password");
    }
  });

  it("dialog title and body copy, no em dashes", () => {
    const html = renderToStaticMarkup(createElement(TempPasswordDialog, { name: "Nicholas Leary", email: WORK, password: "abc-def-ghi-jkl", onDone: () => {} }));
    expect(html).toContain(`>Create temporary password for ${WORK}</h2>`);
    expect(PasswordCopy.TEMP_BODY).toBe("This password is shown only once. Copy it now and share it by phone or in person. They'll choose their own password the first time they sign in.");
    expect(html).toContain(PasswordCopy.TEMP_BODY.replace(/'/g, "&#x27;"));
    for (const s of [PasswordCopy.TEMP_BODY, PasswordCopy.tempDialogTitle(WORK)]) expect(s).not.toMatch(/\u2014/);
  });
});

const { ProjectDrawer } = (await import("@/components/ProjectDashboard")) as unknown as { ProjectDrawer: (p: Record<string, unknown>) => ReactNode };

describe("Edit drawer: the details view's People editor stays out of edit mode", () => {
  const row = { id: "p1", name: "Project 02", serviceArea: null, status: "OffTrack", owner: "Luis Ortega", physicianChampion: null, contractsLead: null, inforRequestNumber: null, nextMilestone: null, dueDate: null, overdue: false, flags: [] } as never;
  const people = createElement("section", { "aria-label": "Edit project", "data-testid": "details-people" }, "Owner Requester Contracts lead Department");
  const render = (form: ReactNode) => renderToStaticMarkup(createElement(ProjectDrawer, { row, today: "2026-09-27", onClose: () => {}, peopleEditor: people, adminControls: null, form }));

  it("details view shows its People editor", () => {
    expect(render(null)).toContain('data-testid="details-people"');
  });

  it("edit mode has no leaked block: only the header and the form", () => {
    const html = render(createElement("div", { "data-testid": "edit-form" }, "form"));
    expect(html).not.toContain("details-people");
    expect(html).toMatch(/<aside aria-label="Edit project"[^>]*><div class="flex shrink-0[^"]*">[\s\S]*?<\/div><div data-testid="edit-form">form<\/div><\/aside>$/);
  });

  it("the two drawers are separate elements (distinct keys), so switching to Edit never reuses the details DOM", () => {
    const drawer = src("src/components/ProjectDashboard.tsx");
    expect(drawer).toMatch(/<aside\s+key="drawer-form"/);
    expect(drawer).toMatch(/<aside\s+key="drawer-detail"/);
  });

  it("the form's People section uses the same Section label as Project and Progress, and has no Department", () => {
    const form = src("src/components/ProjectEditForm.tsx");
    expect(form).toMatch(/<Section title="People"/);
    expect(form).toMatch(/<Section title="Project">/);
    expect(src("src/components/ProjectDashboard.tsx")).toMatch(/<ProjectPeopleEditor\s+key=\{`form-\$\{selected\.id\}`\}\s+inForm/);
  });
});

describe("Recent changes: labels and plain summaries", () => {
  // Every code in start-date-samples/change-codes.md, with its sample stored values.
  type Case = { kind: string; field: string; old: unknown; new: unknown; change: string; oldText?: string; newText?: string; parent?: string };
  const J = (v: unknown) => (v === null ? null : typeof v === "string" ? v : JSON.stringify(v));
  const CASES: Case[] = [
    { kind: "project", field: "archivedAt", old: null, new: "2026-09-12T15:00:00.000Z", change: "Deleted at", oldText: "None", newText: "Sep 12, 2026, 11:00 AM ET" },
    { kind: "project", field: "deletedBy", old: null, new: "nick.leary@example.org", change: "Deleted by", newText: "nick.leary@example.org" },
    { kind: "project", field: "hiddenFromDashboard", old: "false", new: "true", change: "Hidden from dashboard", oldText: "No", newText: "Yes" },
    { kind: "project", field: "hiddenFromReport", old: "false", new: "true", change: "Hidden from report", oldText: "No", newText: "Yes" },
    { kind: "project", field: "startDate", old: "2026-09-26", new: "2026-03-03", change: "Start date changed", oldText: "Sep 26, 2026", newText: "Mar 3, 2026" },
    { kind: "viewSettings", field: "viewSettings", old: { hiddenStatuses: [] }, new: { hiddenStatuses: ["Cancelled", "NotStarted"] }, change: "Dashboard view", oldText: "Hidden statuses: None", newText: "Hidden statuses: Cancelled, Not started" },
    { kind: "serviceLine", field: "serviceLine.migrated", old: null, new: { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" }, change: "Service lines added", newText: "Cardiovascular & Pulmonary Service Line (CVPSL)" },
    { kind: "serviceLine", field: "serviceLine.created", old: null, new: { name: "Neuroscience Service Line", shortName: "NSL" }, change: "Service line added", newText: "Neuroscience Service Line (NSL)" },
    { kind: "serviceLine", field: "serviceLine.renamed", old: { name: "Heart and Lung Service Line", shortName: "HLSL" }, new: { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" }, change: "Service line renamed", oldText: "Heart and Lung Service Line (HLSL)" },
    { kind: "serviceLine", field: "serviceLine.archived", old: null, new: null, change: "Service line archived", oldText: "None", newText: "None" },
    { kind: "serviceLine", field: "serviceLine.unarchived", old: null, new: null, change: "Service line unarchived" },
    { kind: "serviceLine", field: "serviceLine.deleted", old: { name: "Neuroscience Service Line", shortName: "NSL" }, new: null, change: "Service line deleted", newText: "None" },
    { kind: "serviceLine", field: "serviceLine.restored", old: null, new: { name: "Neuroscience Service Line", shortName: "NSL" }, change: "Service line restored" },
    { kind: "serviceLine", field: "serviceLine.departments_changed", old: [], new: ["Cath", "EP", "Echo"], change: "Service line departments changed", oldText: "None" },
    { kind: "serviceLine", field: "serviceLine.contracts_leads_changed", old: ["Amber Hatley"], new: ["Amber Hatley", "Dave Dermady", "Jeff Krause"], change: "Contracts leads changed", newText: "Amber Hatley, Dave Dermady, Jeff Krause" },
    { kind: "serviceLine", field: "serviceLine.owners_changed", old: ["Dr. Patel"], new: ["Dr. Patel", "Kim Nguyen", "Luis Ortega"], change: "Service line owners changed", newText: "Dr. Patel, Kim Nguyen, Luis Ortega" },
    { kind: "serviceLine", field: "serviceLine.requesters_changed", old: null, new: ["Dr. Requester 1", "Dr. Requester 2"], change: "Service line requesters changed", newText: "Dr. Requester 1, Dr. Requester 2" },
    { kind: "template", field: "template.template_created", old: null, new: { name: "EP lab refresh" }, change: "Milestone template added", newText: "EP lab refresh" },
    { kind: "template", field: "template.template_renamed", old: { name: "EP lab refresh" }, new: { name: "EP lab refresh 2027" }, change: "Milestone template renamed", oldText: "EP lab refresh" },
    { kind: "template", field: "template.template_deleted", old: { name: "Scratch", items: ["Step 1"] }, new: null, change: "Milestone template deleted", oldText: "Scratch", newText: "None" },
    { kind: "template", field: "template.templates_reordered", old: ["Capital purchase", "Service agreement"], new: ["Service agreement", "Capital purchase", "Product trial"], change: "Milestone template order changed", newText: "Service agreement, Capital purchase, Product trial" },
    { kind: "template", field: "template.item_added", old: null, new: { name: "EP step 1", position: 1 }, change: "Milestone step added", newText: "EP step 1 (step 1) in EP lab refresh", parent: "EP lab refresh" },
    { kind: "template", field: "template.item_renamed", old: { name: "Vendor quote" }, new: { name: "Vendor quote received" }, change: "Milestone step renamed", newText: "Vendor quote received" },
    { kind: "template", field: "template.item_deleted", old: { name: "Vendor quote", position: 2 }, new: null, change: "Milestone step deleted", oldText: "Vendor quote" },
    { kind: "template", field: "template.items_reordered", old: ["Vendor quote", "Bid award"], new: ["Bid award", "Vendor quote", "Contract signed"], change: "Milestone step order changed", newText: "Bid award, Vendor quote, Contract signed" },
    { kind: "layout", field: "layout.columns", old: null, new: { order: ["project", "people", "status", "milestoneUpdate", "dueFlags"], shares: { people: 0.1316 } }, change: "Dashboard columns changed", oldText: "None", newText: "Project, People, Status, Next milestone / Latest update, Due / Flags" },
    { kind: "layout", field: "layout.columns.reset", old: { order: ["project", "status"], shares: {} }, new: null, change: "Dashboard columns reset", oldText: "Project, Status", newText: "Default layout" },
    { kind: "layout", field: "layout.rows", old: {}, new: { d1: ["p1", "p2"] }, change: "Dashboard row order changed", oldText: "Default order", newText: "Custom order" },
    { kind: "layout", field: "layout.rows.reset", old: { d1: ["p1"] }, new: {}, change: "Dashboard row order reset", oldText: "Custom order", newText: "Default order" },
    { kind: "department", field: "department.seeded", old: null, new: { name: "IR", archived: false, position: 7, shortName: "IR" }, change: "Department added at setup", oldText: "None", newText: "IR" },
    { kind: "department", field: "department.created", old: null, new: { name: "Vascular", shortName: "VASC", position: 8 }, change: "Department added", newText: "Vascular (VASC)" },
    { kind: "department", field: "department.edited", old: { name: "Cath Lab", shortName: "Cath" }, new: { name: "Cath Lab", shortName: "CATH" }, change: "Department edited", oldText: "Cath Lab (Cath)", newText: "Cath Lab (CATH)" },
    { kind: "department", field: "department.moved", old: ["IR", "Cath Lab"], new: ["Cath Lab", "EP Lab", "Echo", "CVSS", "INU", "CardioNeuro", "IR"], change: "Department order changed", newText: "Cath Lab, EP Lab, Echo, CVSS, INU, CardioNeuro, IR" },
    { kind: "department", field: "department.archived", old: null, new: { name: "INU" }, change: "Department archived", newText: "INU" },
    { kind: "department", field: "department.unarchived", old: null, new: { name: "INU" }, change: "Department unarchived", newText: "INU" },
    { kind: "department", field: "department.deleted", old: { name: "INU", shortName: "INU", position: 5 }, new: { movedTo: "Cath Lab", moved: 3 }, change: "Department deleted", oldText: "INU", newText: "Moved 3 projects to Cath Lab" },
    { kind: "department", field: "department.restored", old: null, new: { name: "INU", shortName: "INU", position: 5 }, change: "Department restored", newText: "INU" },
  ];
  const ev = (c: Case) => ({ kind: c.kind, field: c.field, oldValue: J(c.old), newValue: J(c.new), comment: null, subject: "dashboard", parent: c.parent ?? null });

  it("every code in the list has a plain label (never the raw code)", () => {
    const codes = CASES.map((c) => c.field);
    expect(new Set(codes).size).toBe(37);
    for (const c of CASES) {
      expect(AuditText.change(ev(c)), c.field).toBe(c.change);
      expect(AuditText.change(ev(c))).not.toContain(".");
    }
    // Every label in the map is used by the list (plus report colors from #42).
    expect(Object.keys(AuditCopy.LABELS).filter((k) => !codes.includes(k))).toEqual(["reportColors.bar", "reportColors.band"]);
  });

  it("OLD / NEW use the same template, read plainly, and never show raw JSON or positions", () => {
    for (const c of CASES) {
      for (const side of ["old", "new"] as const) {
        const text = AuditText.summary(ev(c), side);
        expect(text, `${c.field} ${side}`).not.toMatch(/[{}[\]"]|[a-z]:\S|position/i);
        expect(text.trim()).not.toBe("");
      }
      if (c.oldText) expect(AuditText.summary(ev(c), "old"), c.field).toBe(c.oldText);
      if (c.newText) expect(AuditText.summary(ev(c), "new"), c.field).toBe(c.newText);
    }
  });

  it("department.deleted: plurals follow the count, and no projects reads plainly", () => {
    const del = (n: unknown) => ({ kind: "department", field: "department.deleted", oldValue: null, newValue: J(n), comment: null });
    expect(AuditText.summary(del({ movedTo: "EP Lab", moved: 1 }), "new")).toBe("Moved 1 project to EP Lab");
    expect(AuditText.summary(del({ movedTo: "EP Lab", moved: 0 }), "new")).toBe("No projects to move");
    expect(AuditText.summary(del(null), "new")).toBe("No projects to move");
  });

  it("layout.columns with the same order reads Column widths changed; a step row without its template leaves 'in' off", () => {
    const order = ["project", "people", "status"];
    const e = { kind: "layout", field: "layout.columns", oldValue: J({ order, shares: { people: 0.2 } }), newValue: J({ order, shares: { people: 0.3 } }), comment: null };
    expect(AuditText.summary(e, "new")).toBe("Column widths changed");
    expect(AuditText.summary(e, "old")).toBe("Project, People, Status");
    const step = { kind: "template", field: "template.item_added", oldValue: null, newValue: J({ name: "Kickoff", position: 2 }), comment: null, parent: null };
    expect(AuditText.summary(step, "new")).toBe("Kickoff (step 2)");
  });

  it("unknown future codes get a humanized label and a plain summary, never a JSON dump", () => {
    const e = { kind: "department", field: "department.merged_into", oldValue: J({ name: "INU", shortName: "INU" }), newValue: J({ target: "Cath Lab", count: 2, enabled: true, when: "2026-09-12T15:00:00.000Z" }), comment: null };
    expect(AuditText.change(e)).toBe("Department merged into");
    expect(AuditText.summary(e, "old")).toBe("INU");
    expect(AuditText.summary(e, "new")).toBe("Target: Cath Lab; Count: 2; Enabled: Yes; When: Sep 12, 2026, 11:00 AM ET");
    const other = { kind: "somethingNew", field: "somethingNew.fooBar", oldValue: null, newValue: J([{ name: "A" }, "B"]), comment: null };
    expect(AuditText.change(other)).toBe("Something new foo bar");
    expect(AuditText.summary(other, "new")).toBe("A, B");
  });

  it("WHO: a migration actor reads 'system (migration NNNN)', display only", () => {
    expect(AuditText.who("migration:0016")).toBe("system (migration 0016)");
    expect(AuditText.who("system (migration 0018)")).toBe("system (migration 0018)");
    expect(AuditText.who("nleary@gmail.com")).toBe("nleary@gmail.com");
    expect(src("src/app/admin/audit/page.tsx")).toContain("by={AuditText.who(e.by)}");
  });

  it("Details shows the raw stored values; service lines and access format from the raw value", () => {
    const sl = { kind: "serviceLine", field: "serviceLine.created", oldValue: null, newValue: "Oncology (Oncology)", oldRaw: null, newRaw: J({ name: "Oncology", shortName: "Oncology" }), comment: null };
    expect(AuditText.summary(sl, "new")).toBe("Oncology");
    expect(AuditText.raw(sl, "new")).toBe('{"name":"Oncology","shortName":"Oncology"}');
    expect(AuditText.raw(sl, "old")).toBe("None");
    const access = { kind: "access", field: "access.moved", oldValue: "INU", newValue: "Cath Lab", oldRaw: null, newRaw: J({ from: "INU", to: "Cath Lab" }), comment: "Pat Lee's INU access moved to Cath Lab when INU was deleted." };
    expect([AuditText.change(access), AuditText.summary(access, "old"), AuditText.summary(access, "new")]).toEqual([access.comment, "INU", "Cath Lab"]);
  });

  it("the row: Details disclosure, 2-line clamp with the full text on hover", async () => {
    const { AuditChangeRow } = await import("@/components/AuditChangeRow");
    const long = Array.from({ length: 40 }, (_, i) => `Person ${i}`).join(", ");
    const props = { id: "0", when: "Sep 27, 2026, 5:00 PM ET", by: "nick@example.org", subject: "CVPSL", change: "Service line owners changed", oldText: "None", newText: long, oldRaw: "None", newRaw: "[...]" };
    const closed = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(AuditChangeRow, props))));
    expect(closed).toContain('data-testid="audit-details">Details</button>');
    expect(closed).toContain(`title="${long}"`);
    expect(closed).toMatch(/class="line-clamp-2[^"]*" data-testid="audit-new"/);
    expect(closed).not.toContain("audit-raw");
    const open = renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(AuditChangeRow, { ...props, initialOpen: true }))));
    expect(open).toContain('data-testid="audit-raw"');
    expect(open).toContain("[...]");
  });

  it("stored rows stay untouched: no migration in this change, the page formats at display time", () => {
    const migrations = readFileSync(path.join(ROOT, "prisma/migrations/0027_report_colors/migration.sql"), "utf8");
    expect(migrations).toBeTruthy();
    expect(src("src/app/admin/audit/page.tsx")).toContain("AuditText.summary(e, \"old\")");
    expect(src("src/lib/admin/AuditText.ts")).not.toMatch(/\.(update|create|upsert|delete)\(/);
  });
});

describe("Report colors: live preview and default labels", () => {
  const DEF = ReportColorScheme.DEFAULTS;
  it("previews a typed custom color even when it fails contrast (#777777); Save stays blocked", () => {
    expect(ReportColorScheme.check("#777777").ok).toBe(false);
    const p = ReportColorScheme.preview({ bar: "#777777", band: "none" }, DEF);
    expect(p.bar.fill).toBe(ReportColorScheme.derive("#777777").bar.fill);
    expect(p.band).toBeNull();
    const band = ReportColorScheme.preview({ bar: "navy", band: "#777777" }, DEF);
    expect(band.band!.fill).toBe(ReportColorScheme.derive("#777777").band.fill);
  });

  it("only unparseable input keeps the last valid color", () => {
    const last = { bar: "#777777", band: "plum" };
    const p = ReportColorScheme.preview({ bar: "#7777", band: "#12" }, last);
    expect(p.bar.fill).toBe(ReportColorScheme.derive("#777777").bar.fill);
    expect(p.band!.fill).toBe(ReportColorScheme.PRESETS.plum.band.fill);
    expect(ReportColorScheme.preview({ bar: "zzz", band: "none" }, DEF).bar.fill).toBe(ReportColorScheme.PRESETS.navy.bar.fill);
  });

  it("segmented options say (default); Recent changes keeps the plain names", () => {
    expect(ReportColorScheme.optionLabel("navy", "bar")).toBe("Navy solid (default)");
    expect(ReportColorScheme.optionLabel("none", "band")).toBe("None (default)");
    expect(ReportColorScheme.optionLabel("navy", "band")).toBe("Navy solid");
    expect(ReportColorScheme.optionLabel("plum", "bar")).toBe("Plum");
    expect(ReportColorScheme.optionLabel("custom", "bar")).toBe("Custom");
    expect([ReportColorScheme.label("navy"), ReportColorScheme.label("none")]).toEqual(["Navy solid", "None"]);
    expect(src("src/components/ReportColorsForm.tsx")).toContain("ReportColorScheme.optionLabel(k, field)");
  });

  it("the form renders the default labels in the segmented controls", async () => {
    vi.doMock("@/app/actions/reports", () => ({ saveReportColors: async () => null }));
    const { ReportColorsForm } = await import("@/components/ReportColorsForm");
    const html = renderToStaticMarkup(createElement(ReportColorsForm, { colors: DEF }));
    expect(html).toContain("Navy solid (default)");
    expect(html).toContain("None (default)");
  });
});
