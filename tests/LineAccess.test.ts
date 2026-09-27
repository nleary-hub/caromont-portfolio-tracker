import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AccessGridModel } from "@/lib/access/AccessGridModel";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { LineGate } from "@/lib/access/LineGate";
import { NoLineAccessError, ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { LineAccessService } from "@/lib/services/LineAccessService";
import { ServiceLineForms } from "@/lib/services/ServiceLineForms";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = Factory.ADMIN;
const JANE = { email: "jane.doe@caromonthealth.org", isAdmin: false };
const ENV = { ALLOWED_EMAILS: "@caromonthealth.org @example.org", ADMIN_EMAILS: "admin@example.org nick.leary@caromonthealth.org" };
const CVPSL = ServiceLine.DEFAULT_ID;

class World {
  static make() {
    const fake = new FakeDb();
    const db = fake.asClient();
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" });
    const onc = fake.addLine({ name: "Oncology Service Line", shortName: "ONC" });
    const arc = fake.addLine({ name: "Archived Line", shortName: "ARC", archivedAt: new Date() });
    return { fake, db, ep: ep.id as string, onc: onc.id as string, arc: arc.id as string };
  }
}

describe("Writing Bot copy (item 8)", () => {
  it("is exact and has no em dashes", () => {
    expect(LineAccessCopy.heading(3)).toBe("Access (3)");
    expect(LineAccessCopy.NOTE).toBe("Covers all service lines. Admins can see every line.");
    expect(LineAccessCopy.ALL_LINES).toBe("All lines");
    expect(LineAccessCopy.ADMIN_LOCK_TOOLTIP).toBe("Admins can see every service line.");
    expect(LineAccessCopy.NO_ACCESS_TAG).toBe("No access");
    expect(LineAccessCopy.NO_ACCESS_TOOLTIP).toBe("Can't see any service line yet.");
    expect(LineAccessCopy.checkboxLabel("Jane Doe", "CVPSL")).toBe("Jane Doe, CVPSL access");
    expect(LineAccessCopy.grantedToast("Jane Doe", "CVPSL")).toBe("Jane Doe can now see CVPSL.");
    expect(LineAccessCopy.revokedToast("Jane Doe", "CVPSL")).toBe("Jane Doe can no longer see CVPSL.");
    expect(LineAccessCopy.SAVE_ERROR).toBe("Couldn't save access. Try again.");
    expect(LineAccessCopy.EMPTY).toBe("No other users yet. Add someone by email, or they'll show up here after their first sign-in.");
    expect(LineAccessCopy.removeLastTitle("Jane Doe")).toBe("Remove Jane Doe's last line?");
    expect(LineAccessCopy.REMOVE_LAST_BODY).toBe("They won't see any projects until an admin gives them access again.");
    expect([LineAccessCopy.REMOVE_LAST_BUTTON, LineAccessCopy.CANCEL]).toEqual(["Remove access", "Cancel"]);
    expect([LineAccessCopy.ADD_FIELD, LineAccessCopy.ADD_HELPER]).toEqual(["Email", "They'll see only the lines you check here."]);
    expect([LineAccessCopy.INVALID_EMAIL, LineAccessCopy.DUPLICATE_EMAIL]).toEqual(["Enter a valid email address.", "That email is already on the list."]);
    expect(LineAccessCopy.addedToast("jane.doe@caromonthealth.org")).toBe("jane.doe@caromonthealth.org added.");
    expect([LineAccessCopy.NO_ACCESS_TITLE, LineAccessCopy.NO_ACCESS_BODY]).toEqual(["You don't have access yet", "Ask an admin to add you to a service line."]);
    expect(LineAccessCopy.signedInAs("jane.doe@caromonthealth.org")).toBe("Signed in as jane.doe@caromonthealth.org");
    expect(LineAccessCopy.SIGN_OUT).toBe("Sign out");
    expect([LineAccessCopy.lineTitle("CVPSL"), LineAccessCopy.LINE_BODY, LineAccessCopy.goTo("EP")]).toEqual(["You don't have access to CVPSL", "Ask an admin if you need it.", "Go to EP"]);
    const files = ["src/lib/access/LineAccessCopy.ts", "src/components/AccessAdmin.tsx", "src/components/NoAccessCard.tsx", "src/lib/access/LineGate.ts", "src/lib/services/LineAccessService.ts", "prisma/migrations/0023_line_access/migration.sql"];
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toContain("\u2014");
  });
});

describe("ServiceLineAccess with per-line access", () => {
  it("admins use every open line; others only the open lines they were given; none = NoLineAccessError", async () => {
    const { fake, db, ep, arc } = World.make();
    expect((await ServiceLineAccess.usableLines(ADMIN, db)).map((l) => l.shortName)).toEqual(["CVPSL", "EP", "ONC"]);
    expect(await ServiceLineAccess.usableLines(JANE, db)).toEqual([]);
    await expect(ServiceLineAccess.activeFor(JANE, db)).rejects.toBeInstanceOf(NoLineAccessError);
    expect(await ServiceLineAccess.activeOrNull(JANE, db)).toBeNull();
    await expect(ServiceLineAccess.activeOrDefault(JANE, db)).rejects.toBeInstanceOf(NoLineAccessError);
    // An archived line is not usable even with a row.
    fake.grant(JANE.email, ep, arc);
    expect((await ServiceLineAccess.usableLines(JANE, db)).map((l) => l.shortName)).toEqual(["EP"]);
    expect((await ServiceLineAccess.activeFor(JANE, db)).shortName).toBe("EP");
    // Email case does not matter.
    expect((await ServiceLineAccess.usableLines({ email: "Jane.Doe@CaromontHealth.org ", isAdmin: false }, db)).map((l) => l.shortName)).toEqual(["EP"]);
  });

  it("switching: anyone, but only to their own lines; the saved choice is dropped when access is removed", async () => {
    const { fake, db, ep, onc } = World.make();
    fake.grant(JANE.email, CVPSL, ep);
    expect(await ServiceLineForms.switchTo(JANE, ep, db)).toMatchObject({ ok: true, switchedTo: "EP" });
    expect((await ServiceLineAccess.activeFor(JANE, db)).shortName).toBe("EP");
    expect(await ServiceLineForms.switchTo(JANE, onc, db)).toEqual({ ok: false, message: "That service line is not available." });
    await LineAccessService.setAccess(ADMIN, JANE.email, ep, false, db, ENV);
    expect((await ServiceLineAccess.activeFor(JANE, db)).shortName).toBe("CVPSL");
  });
});

describe("LineGate (dashboard and report archive)", () => {
  it("no line: the no-access card only, whatever the link says", async () => {
    const { db } = World.make();
    expect(await LineGate.forPage(JANE, undefined, "/", db)).toEqual({ kind: "none" });
    expect(await LineGate.forPage(JANE, "CVPSL", "/", db)).toEqual({ kind: "none" });
  });

  it("a link to one of your lines saves it and reloads without the parameter", async () => {
    const { fake, db, ep } = World.make();
    fake.grant(JANE.email, CVPSL, ep);
    expect(await LineGate.forPage(JANE, "ep", "/reports", db)).toEqual({ kind: "switched", to: "/reports" });
    expect(fake.state.serviceLineUserState.find((u) => u.email === JANE.email)?.serviceLineId).toBe(ep);
    const ok = await LineGate.forPage(JANE, undefined, "/", db);
    expect(ok).toMatchObject({ kind: "ok", scope: { shortName: "EP" } });
  });

  it("a link to a line you lack names it and offers your first line; a line that doesn't exist looks the same", async () => {
    const { fake, db, ep } = World.make();
    fake.grant(JANE.email, ep);
    const lacks = await LineGate.forPage(JANE, "CVPSL", "/", db);
    expect(lacks).toEqual({ kind: "lacks", requested: "CVPSL", first: { shortName: "EP" } });
    // Nothing else about CVPSL (no id, name or counts) is in the result the page renders from.
    expect(JSON.stringify(lacks)).not.toMatch(/Cardiovascular|00000000|projects/i);
    expect(await LineGate.forPage(JANE, "NOPE", "/", db)).toEqual({ kind: "lacks", requested: "NOPE", first: { shortName: "EP" } });
    // Archived lines are not reachable by link either.
    expect(await LineGate.forPage(JANE, "ARC", "/", db)).toMatchObject({ kind: "lacks" });
    // Not a short code: ignored.
    expect(await LineGate.forPage(JANE, "<script>", "/", db)).toMatchObject({ kind: "ok", scope: { shortName: "EP" } });
    expect(LineGate.requestedCode([" ep "])).toBe("EP");
    expect(LineGate.href("/", "EP")).toBe("/?line=EP");
  });

  it("switcher: exactly one line = one entry (plain label); more = all of them, default first", async () => {
    const { fake, db, ep, onc } = World.make();
    fake.grant(JANE.email, ep);
    expect((await LineGate.forPage(JANE, undefined, "/", db)) as { lines: unknown[] }).toMatchObject({ lines: [{ shortName: "EP" }] });
    fake.grant(JANE.email, onc, CVPSL);
    const g = (await LineGate.forPage(JANE, undefined, "/", db)) as { lines: { shortName: string }[] };
    expect(g.lines.map((l) => l.shortName)).toEqual(["CVPSL", "EP", "ONC"]);
  });

  it("the switcher shows Manage service lines to admins only; the slot shows the plain label for one line", () => {
    const sw = readFileSync("src/components/ServiceLineSwitcher.tsx", "utf8");
    expect(sw).toMatch(/\{manage && \(/);
    const slot = readFileSync("src/components/ServiceLineSlot.tsx", "utf8");
    expect(slot).toContain("if (!viewer.isAdmin && lines.length < 2) return <ServiceLineLabel");
    expect(slot).toContain("manage={viewer.isAdmin}");
  });
});

describe("LineAccessService (Admin > People > Access)", () => {
  it("grid: admin only; every open line; admins first (locked), then everyone else A to Z; the count is non-admins", async () => {
    const { fake, db, ep } = World.make();
    await expect(LineAccessService.grid(JANE, db, ENV)).rejects.toBeInstanceOf(AdminRequiredError);
    fake.grant("zed.young@caromonthealth.org", ep);
    fake.grant("amy.baker@caromonthealth.org", CVPSL, ep);
    fake.state.appUsers.push({ email: JANE.email, name: "Jane Doe", firstSignInAt: new Date(), addedBy: null, createdAt: new Date() });
    fake.state.appUsers.push({ email: "admin@example.org", name: null, firstSignInAt: new Date(), addedBy: null, createdAt: new Date() });
    const grid = await LineAccessService.grid(ADMIN, db, ENV);
    expect(grid.lines.map((l) => [l.shortName, l.name])).toEqual([
      ["CVPSL", "Cardiovascular & Pulmonary Service Line"],
      ["EP", "Electrophysiology Service Line"],
      ["ONC", "Oncology Service Line"],
    ]);
    // Admins: signed-in ones plus exact ADMIN_EMAILS entries not seen yet.
    expect(grid.admins.map((r) => [r.name, r.email, r.lineIds])).toEqual([
      ["Admin", "admin@example.org", []],
      ["Nick Leary", "nick.leary@caromonthealth.org", []],
    ]);
    expect(grid.users.map((r) => [r.name, r.lineIds.length])).toEqual([
      ["Amy Baker", 2],
      ["Jane Doe", 0],
      ["Zed Young", 1],
    ]);
    expect(LineAccessCopy.heading(grid.users.length)).toBe("Access (3)");
    expect(grid.canAdd).toBe(true);
  });

  it("checking and unchecking: toasts with the name and short code, logged, idempotent; admins and archived lines are refused", async () => {
    const { fake, db, ep, arc } = World.make();
    fake.state.appUsers.push({ email: JANE.email, name: "Jane Doe", firstSignInAt: new Date(), addedBy: null, createdAt: new Date() });
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, CVPSL, true, db, ENV)).toEqual({ ok: true, message: "Jane Doe can now see CVPSL." });
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, CVPSL, true, db, ENV)).toEqual({ ok: true, message: "Jane Doe can now see CVPSL." });
    expect(fake.state.accessGrants.filter((g) => g.email === JANE.email)).toHaveLength(1);
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, ep, true, db, ENV)).toMatchObject({ ok: true });
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, CVPSL, false, db, ENV)).toEqual({ ok: true, message: "Jane Doe can no longer see CVPSL." });
    expect(fake.state.accessHistory.map((h) => [h.action, h.serviceLineId, h.changedBy])).toEqual([
      ["granted", CVPSL, ADMIN.email],
      ["granted", ep, ADMIN.email],
      ["revoked", CVPSL, ADMIN.email],
    ]);
    // Removing the last line is allowed on the server (the page asks first).
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, ep, false, db, ENV)).toMatchObject({ ok: true });
    expect(fake.state.accessGrants.filter((g) => g.email === JANE.email)).toEqual([]);
    expect(await LineAccessService.setAccess(ADMIN, JANE.email, arc, true, db, ENV)).toEqual({ ok: false, message: "Couldn't save access. Try again." });
    expect(await LineAccessService.setAccess(ADMIN, "nick.leary@caromonthealth.org", CVPSL, true, db, ENV)).toEqual({ ok: false, message: "Couldn't save access. Try again." });
    expect(await LineAccessService.setAccess(ADMIN, "nobody@caromonthealth.org", CVPSL, true, db, ENV)).toEqual({ ok: false, message: "Couldn't save access. Try again." });
    await expect(LineAccessService.setAccess(JANE, JANE.email, CVPSL, true, db, ENV)).rejects.toBeInstanceOf(AdminRequiredError);
  });

  it("Add user: before first sign-in, no lines; validates the email; duplicates and emails that can't sign in are refused", async () => {
    const { fake, db } = World.make();
    expect(await LineAccessService.addUser(ADMIN, "not an email", db, ENV)).toEqual({ ok: false, message: "Enter a valid email address." });
    expect(await LineAccessService.addUser(ADMIN, "jane@", db, ENV)).toEqual({ ok: false, message: "Enter a valid email address." });
    expect(await LineAccessService.addUser(ADMIN, " Jane.Doe@CaromontHealth.org ", db, ENV)).toEqual({ ok: true, message: "jane.doe@caromonthealth.org added." });
    expect(fake.state.appUsers.find((u) => u.email === JANE.email)).toMatchObject({ addedBy: ADMIN.email, firstSignInAt: null });
    expect(fake.state.accessGrants).toEqual([]);
    expect(await LineAccessService.addUser(ADMIN, "jane.doe@caromonthealth.org", db, ENV)).toEqual({ ok: false, message: "That email is already on the list." });
    expect(await LineAccessService.addUser(ADMIN, "nick.leary@caromonthealth.org", db, ENV)).toEqual({ ok: false, message: "That email is already on the list." });
    expect(await LineAccessService.addUser(ADMIN, "someone@gmail.com", db, ENV)).toEqual({ ok: false, message: LineAccessCopy.NOT_ALLOWED_EMAIL });
    await expect(LineAccessService.addUser(JANE, "x@caromonthealth.org", db, ENV)).rejects.toBeInstanceOf(AdminRequiredError);
    // The pre-added person signs in: recorded, still no lines until an admin checks one.
    await LineAccessService.touch({ ...JANE, name: "Jane Doe" }, db);
    expect(fake.state.appUsers.find((u) => u.email === JANE.email)).toMatchObject({ name: "Jane Doe" });
    expect(await ServiceLineAccess.usableLines(JANE, db)).toEqual([]);
  });

  it("first sign-in records the person with no lines (new users start with none)", async () => {
    const { fake, db } = World.make();
    await LineAccessService.touch({ email: "New.Person@caromonthealth.org", isAdmin: false, name: "new.person@caromonthealth.org" }, db);
    expect(fake.state.appUsers).toEqual([expect.objectContaining({ email: "new.person@caromonthealth.org", name: null })]);
    await LineAccessService.touch({ email: "new.person@caromonthealth.org", isAdmin: false, name: "New Person" }, db);
    expect(fake.state.appUsers).toHaveLength(1);
    expect(fake.state.appUsers[0]).toMatchObject({ name: "New Person" });
    expect(fake.state.accessGrants).toEqual([]);
    expect(LineAccessService.displayName({ email: "new.person@caromonthealth.org" })).toBe("New Person");
  });
});

describe("Access grid rules", () => {
  it("asks before removing someone's last line; the amber tag marks people with none", () => {
    const row = { email: "j@x.org", name: "Jane", isAdmin: false, lineIds: ["a"] };
    expect(AccessGridModel.needsConfirm(row, "a", false)).toBe(true);
    expect(AccessGridModel.needsConfirm(row, "a", true)).toBe(false);
    expect(AccessGridModel.needsConfirm({ ...row, lineIds: ["a", "b"] }, "a", false)).toBe(false);
    expect(AccessGridModel.toggle(row, "b", true).lineIds).toEqual(["a", "b"]);
    expect(AccessGridModel.toggle(row, "a", false).lineIds).toEqual([]);
    expect(AccessGridModel.hasNoAccess({ ...row, lineIds: [] })).toBe(true);
    expect(AccessGridModel.hasNoAccess({ ...row, isAdmin: true, lineIds: [] })).toBe(false);
  });
});
