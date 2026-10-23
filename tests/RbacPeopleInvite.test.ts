import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RoleAssignment, type RoleOption } from "@/lib/people/RoleAssignment";
import { ROLE_DEFAULTS, OWNER_RANK } from "@/lib/permissions/RoleDefaults";
import { PeopleRoleService, type PeopleRoleStore, type StoredPerson } from "@/lib/services/PeopleRoleService";
import { ViewerDashboardModel } from "@/lib/dashboard/ViewerDashboardModel";

// Roles & Permissions 4/6: People and invite. Fictional people only (example.org).
const OWNER = "jordan.pike@example.org";
const ADMIN = "casey.lund@example.org";
const ADMIN2 = "avery.admin@example.org";
const DIRECTOR = "dana.director@example.org";
const MANAGER = "mo.manager@example.org";
const VIEWER = "riley.moss@example.org";
const ENV = { OWNER_EMAIL: OWNER, ADMIN_EMAILS: "", ALLOWED_EMAILS: "@example.org" } as unknown as NodeJS.ProcessEnv;

const ROLES: RoleOption[] = ROLE_DEFAULTS.map((r) => ({ id: r.id, name: r.name, rank: r.rank, description: "" }));
const user = (email: string, roleId: string, isAdmin = false) => {
  const seed = ROLE_DEFAULTS.find((r) => r.id === roleId)!;
  return { email, isAdmin, roleId, rank: email === OWNER ? OWNER_RANK : seed.rank, keys: [...seed.keys] };
};

describe("rank rule (pure)", () => {
  it("assignable roles are strictly below the actor's own; the Owner can assign Admin and below, never Owner", () => {
    expect(RoleAssignment.assignable(user(OWNER, "admin", true), ROLES, ENV).map((r) => r.id)).toEqual(["admin", "director", "manager", "editor", "viewer"]);
    expect(RoleAssignment.assignable(user(ADMIN, "admin", true), ROLES, ENV).map((r) => r.id)).toEqual(["director", "manager", "editor", "viewer"]);
    expect(RoleAssignment.assignable(user(DIRECTOR, "director"), ROLES, ENV).map((r) => r.id)).toEqual(["manager", "editor", "viewer"]);
    expect(RoleAssignment.assignable(user(MANAGER, "manager"), ROLES, ENV)).toEqual([]);
  });

  it("equal-rank Admins can't act on each other; the Owner can act on everyone but is never a target", () => {
    const admin2 = { email: ADMIN2, roleId: "admin" };
    expect(RoleAssignment.checkAssign(user(ADMIN, "admin", true), admin2, "viewer", ROLES, ENV)).toEqual({ ok: false, message: RoleAssignment.SAME_RANK });
    expect(RoleAssignment.checkAssign(user(OWNER, "admin", true), admin2, "viewer", ROLES, ENV)).toEqual({ ok: true });
    for (const actor of [user(ADMIN, "admin", true), user(OWNER, "admin", true), user(DIRECTOR, "director")]) {
      for (const role of ["viewer", "admin", "director"]) {
        expect(RoleAssignment.checkAssign(actor, { email: OWNER, roleId: null }, role, ROLES, ENV)).toEqual({ ok: false, message: RoleAssignment.OWNER_LOCKED });
      }
      expect(RoleAssignment.canActOn(actor, { email: OWNER.toUpperCase(), roleId: null }, ROLES, ENV)).toBe(false);
    }
  });

  it("a Director can't give Director or Admin, nor change a Director; a Manager can't assign at all", () => {
    const d = user(DIRECTOR, "director");
    expect(RoleAssignment.checkAssign(d, { email: VIEWER, roleId: "viewer" }, "director", ROLES, ENV)).toEqual({ ok: false, message: RoleAssignment.NOT_ALLOWED });
    expect(RoleAssignment.checkAssign(d, { email: VIEWER, roleId: "viewer" }, "admin", ROLES, ENV).ok).toBe(false);
    expect(RoleAssignment.checkAssign(d, { email: "dee.two@example.org", roleId: "director" }, "viewer", ROLES, ENV)).toEqual({ ok: false, message: RoleAssignment.SAME_RANK });
    expect(RoleAssignment.checkAssign(d, { email: VIEWER, roleId: "viewer" }, "manager", ROLES, ENV)).toEqual({ ok: true });
    expect(RoleAssignment.checkAssign(user(MANAGER, "manager"), { email: VIEWER, roleId: "viewer" }, "editor", ROLES, ENV).ok).toBe(false);
  });

  it("nobody changes their own role", () => {
    expect(RoleAssignment.checkAssign(user(ADMIN, "admin", true), { email: ADMIN, roleId: "admin" }, "director", ROLES, ENV).ok).toBe(false);
  });

  it("only the Viewer role (never the Owner or an Admin) gets the viewer dashboard", () => {
    expect(ViewerDashboardModel.isViewerRole({ email: VIEWER, isAdmin: false, roleId: "viewer" })).toBe(true);
    expect(ViewerDashboardModel.isViewerRole({ email: VIEWER, isAdmin: false, roleId: "editor" })).toBe(false);
    expect(ViewerDashboardModel.isViewerRole({ email: ADMIN, isAdmin: true, roleId: "admin" })).toBe(false);
  });
});

/** A store over a real PGlite database with every migration, so the append-only trigger on user_role_history is real. */
class SqlStore implements PeopleRoleStore {
  constructor(readonly db: PGlite) {}
  async roles() {
    return (await this.db.query<{ id: string; name: string; rank: number; allLines: boolean }>(`SELECT id, name, rank, "allLines" FROM role ORDER BY rank DESC`)).rows;
  }
  async roleKeys(roleId: string) {
    const rows = (await this.db.query<{ permission: string }>(`SELECT permission FROM role_permission WHERE "roleId" = $1`, [roleId])).rows;
    return rows.length ? rows.map((r) => r.permission) : null;
  }
  async people(): Promise<StoredPerson[]> {
    const rows = (await this.db.query<{ email: string; name: string | null; roleId: string | null; firstSignInAt: Date | null; createdAt: Date }>(`SELECT email, name, "roleId", "firstSignInAt", "createdAt" FROM app_user`)).rows;
    return rows.map((r) => ({ ...r, lineIds: [], departmentLabel: null, hasPassword: false }));
  }
  async person(email: string) {
    return (await this.people()).find((p) => p.email === email) ?? null;
  }
  async setRole(email: string, from: string | null, to: string, actor: string, id: string) {
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE app_user SET "roleId" = $2 WHERE email = $1`, [email, to]);
      await tx.query(`INSERT INTO user_role_history (id, email, "fromRoleId", "toRoleId", actor) VALUES ($1, $2, $3, $4, $5)`, [id, email, from, to, actor]);
    });
  }
  async invite(email: string, name: string | null, roleId: string, actor: string, id: string) {
    if (await this.person(email)) return false;
    await this.db.transaction(async (tx) => {
      await tx.query(`INSERT INTO app_user (email, name, "addedBy", "roleId") VALUES ($1, $2, $3, $4)`, [email, name, actor, roleId]);
      await tx.query(`INSERT INTO user_role_history (id, email, "fromRoleId", "toRoleId", actor) VALUES ($1, $2, NULL, $3, $4)`, [id, email, roleId, actor]);
    });
    return true;
  }
  async revoke(email: string, from: string | null, actor: string, id: string) {
    return this.db.transaction(async (tx) => {
      const r = await tx.query(`DELETE FROM app_user WHERE email = $1 AND "firstSignInAt" IS NULL`, [email]);
      if (!r.affectedRows) return false;
      await tx.query(`INSERT INTO user_role_history (id, email, "fromRoleId", "toRoleId", actor) VALUES ($1, $2, $3, NULL, $4)`, [id, email, from, actor]);
      return true;
    });
  }
  async aiCost() {
    return {};
  }
  async history() {
    return (await this.db.query<{ email: string; fromRoleId: string | null; toRoleId: string | null; actor: string }>(`SELECT email, "fromRoleId", "toRoleId", actor FROM user_role_history ORDER BY at, id`)).rows;
  }
}

describe("PeopleRoleService over every migration (PGlite)", () => {
  const DIR = path.resolve(__dirname, "../prisma/migrations");
  const folders = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  let store: SqlStore;
  beforeEach(async () => {
    const db = await PGlite.create();
    for (const f of folders) await db.exec(readFileSync(path.join(DIR, f, "migration.sql"), "utf8"));
    for (const [e, r] of [[OWNER, null], [ADMIN, "admin"], [ADMIN2, "admin"], [VIEWER, null]] as const) {
      await db.query(`INSERT INTO app_user (email, name, "firstSignInAt", "roleId") VALUES ($1, $2, now(), $3)`, [e, e.split("@")[0], r]);
    }
    store = new SqlStore(db);
  }, 60_000);

  const as = (email: string, isAdmin = true) => ({ email, isAdmin });

  it("an assignment writes one history row with the resolved from-role; the row can't be updated or deleted", async () => {
    expect(await PeopleRoleService.assignRole(as(ADMIN), VIEWER, "editor", store, ENV)).toMatchObject({ ok: true });
    expect((await store.person(VIEWER))?.roleId).toBe("editor");
    expect(await store.history()).toEqual([{ email: VIEWER, fromRoleId: "viewer", toRoleId: "editor", actor: ADMIN }]);
    await expect(store.db.query(`UPDATE user_role_history SET "toRoleId" = 'admin'`)).rejects.toThrow();
    await expect(store.db.query(`DELETE FROM user_role_history`)).rejects.toThrow();
    expect(await store.history()).toHaveLength(1);
  });

  it("refusals write nothing: the Owner, an equal-rank Admin, and a role at the actor's rank", async () => {
    expect(await PeopleRoleService.assignRole(as(ADMIN), OWNER, "viewer", store, ENV)).toEqual({ ok: false, message: RoleAssignment.OWNER_LOCKED });
    expect(await PeopleRoleService.assignRole(as(OWNER), OWNER, "viewer", store, ENV)).toEqual({ ok: false, message: RoleAssignment.OWNER_LOCKED });
    expect(await PeopleRoleService.assignRole(as(ADMIN), ADMIN2, "viewer", store, ENV)).toEqual({ ok: false, message: RoleAssignment.SAME_RANK });
    expect(await PeopleRoleService.assignRole(as(ADMIN), VIEWER, "admin", store, ENV)).toEqual({ ok: false, message: RoleAssignment.NOT_ALLOWED });
    expect(await PeopleRoleService.assignRole(as(VIEWER, false), ADMIN2, "viewer", store, ENV)).toMatchObject({ ok: false });
    expect(await store.history()).toEqual([]);
    expect((await store.person(ADMIN2))?.roleId).toBe("admin");
  });

  it("the Owner can change an Admin", async () => {
    expect(await PeopleRoleService.assignRole(as(OWNER), ADMIN2, "director", store, ENV)).toMatchObject({ ok: true });
    expect(await store.history()).toEqual([{ email: ADMIN2, fromRoleId: "admin", toRoleId: "director", actor: OWNER }]);
  });

  it("invite: allowlist required, duplicates and the Owner refused, a pending person with a history row; revoke appends", async () => {
    expect(await PeopleRoleService.invite(as(ADMIN), { email: "pat@elsewhere.test", roleId: "viewer" }, store, ENV)).toEqual({ ok: false, message: PeopleRoleService.NOT_ALLOWED_EMAIL });
    expect(await PeopleRoleService.invite(as(ADMIN), { email: VIEWER, roleId: "viewer" }, store, ENV)).toEqual({ ok: false, message: PeopleRoleService.DUPLICATE });
    expect(await PeopleRoleService.invite(as(ADMIN), { email: OWNER, roleId: "viewer" }, store, ENV)).toEqual({ ok: false, message: RoleAssignment.OWNER_LOCKED });
    expect(await PeopleRoleService.invite(as(ADMIN), { email: "new.person@example.org", roleId: "admin" }, store, ENV)).toEqual({ ok: false, message: RoleAssignment.NOT_ALLOWED });
    const ok = await PeopleRoleService.invite(as(ADMIN), { email: "New.Person@example.org", name: "New Person", roleId: "manager" }, store, ENV);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.message).toContain("No email is sent");
    expect(await store.person("new.person@example.org")).toMatchObject({ roleId: "manager", firstSignInAt: null });
    expect(await PeopleRoleService.revoke(as(ADMIN), "new.person@example.org", store, ENV)).toMatchObject({ ok: true });
    expect(await store.history()).toEqual([
      { email: "new.person@example.org", fromRoleId: null, toRoleId: "manager", actor: ADMIN },
      { email: "new.person@example.org", fromRoleId: "manager", toRoleId: null, actor: ADMIN },
    ]);
    // A signed-in person is not a pending invite.
    expect(await PeopleRoleService.revoke(as(ADMIN), VIEWER, store, ENV)).toEqual({ ok: false, message: PeopleRoleService.NOT_PENDING });
  });

  it("the directory shows the Owner locked and offers only roles below the actor", async () => {
    const dir = await PeopleRoleService.directory(as(ADMIN), store, ENV);
    expect(dir?.assignable.map((r) => r.id)).toEqual(["director", "manager", "editor", "viewer"]);
    expect(await PeopleRoleService.directory(as(VIEWER, false), store, ENV)).toBeNull();
  });
});
