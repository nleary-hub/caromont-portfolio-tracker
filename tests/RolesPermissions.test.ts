import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import {
  ALL_KEYS, can, GRANTABLE_KEYS, HIDDEN_KEYS, OWNER_ONLY_KEYS, OwnerLock, PERMISSION_GROUPS, Permissions, ROLE_DEFAULTS, roleSeed, VISIBLE_LOCKED_KEYS,
} from "@/lib/permissions";

// Roles & Permissions PR 1: engine, Owner lock, seeded defaults, migration 0069. Fictional people only.
const ENV = { OWNER_EMAIL: "jordan.pike@example.org" };
const OWNER = { email: "Jordan.Pike@example.org", isAdmin: true };
const ADMIN = { email: "avery.admin@example.org", isAdmin: true };
const as = (roleId: string) => ({ email: `${roleId}.person@example.org`, isAdmin: false, roleId });

describe("permission keys", () => {
  it("has 64 unique keys, 7 Owner-only, 57 grantable, 58 visible in the editor", () => {
    expect(ALL_KEYS).toHaveLength(64);
    expect(new Set(ALL_KEYS).size).toBe(64);
    expect(OWNER_ONLY_KEYS).toHaveLength(7);
    expect(GRANTABLE_KEYS).toHaveLength(57);
    expect(GRANTABLE_KEYS.length + VISIBLE_LOCKED_KEYS.length).toBe(58);
    expect(HIDDEN_KEYS).toHaveLength(6);
    expect(Object.fromEntries(Object.entries(PERMISSION_GROUPS).map(([g, k]) => [g, k.length]))).toEqual({ projects: 9, lifecycle: 3, people: 8, dashboard: 6, reportView: 4, ai: 16, admin: 12 });
  });
});

describe("Permissions.can", () => {
  it("gives the Owner every key, including Owner-only and AI keys", () => {
    for (const k of ALL_KEYS) expect(Permissions.can(OWNER, k, ENV)).toBe(true);
    expect(Permissions.can(OWNER, "not.a.key", ENV)).toBe(false);
  });
  it("never gives an Owner-only key to anyone else, even with it in their keys", () => {
    for (const k of OWNER_ONLY_KEYS) {
      expect(Permissions.can(ADMIN, k, ENV)).toBe(false);
      expect(Permissions.can({ ...as("director"), keys: [k] }, k, ENV)).toBe(false);
    }
  });
  it("keeps AI Owner-only for now", () => {
    expect(Permissions.can(ADMIN, "ai.playbook", ENV)).toBe(false);
    expect(Permissions.can(as("editor"), "ai.dictation", ENV)).toBe(false);
  });
  it("follows the role defaults and stored keys", () => {
    expect(Permissions.can(ADMIN, "admin.roles", ENV)).toBe(true);
    expect(Permissions.can(as("viewer"), "project.edit", ENV)).toBe(false);
    expect(Permissions.can(as("editor"), "project.edit", ENV)).toBe(true);
    expect(Permissions.can(as("manager"), "lifecycle.reopenCancelled", ENV)).toBe(false);
    expect(Permissions.can({ ...as("manager"), keys: ["lifecycle.reopenCancelled"] }, "lifecycle.reopenCancelled", ENV)).toBe(true);
    expect(Permissions.can({ email: "x@example.org", isAdmin: false }, "project.view", ENV)).toBe(true);
    expect(Permissions.can(null, "project.view", ENV)).toBe(false);
    expect(typeof can).toBe("function");
  });
  it("uses ADMIN_EMAILS as a floor and Viewer when no role is stored", () => {
    expect(Permissions.roleIdFor({ isAdmin: true, roleId: "viewer" })).toBe("admin");
    expect(Permissions.roleIdFor({ isAdmin: false, roleId: null })).toBe("viewer");
  });
  it("require throws the generic Not found.", () => {
    expect(() => Permissions.require(as("viewer"), "report.freeze", ENV)).toThrow(/^Not found\.$/);
  });
});

describe("grant rules", () => {
  const director = { id: "director", rank: 40, keys: [] };
  const manager = { id: "manager", rank: 30, keys: [] };
  it("assigns only roles strictly below the actor, never to an Owner", () => {
    expect(Permissions.canAssignRole(ADMIN, director, "eli.editor@example.org", ENV)).toBe(true);
    expect(Permissions.canAssignRole(ADMIN, { id: "admin", rank: 50, keys: [] }, "eli.editor@example.org", ENV)).toBe(false);
    expect(Permissions.canAssignRole(as("director"), director, "eli.editor@example.org", ENV)).toBe(false);
    expect(Permissions.canAssignRole(as("director"), manager, "eli.editor@example.org", ENV)).toBe(true);
    expect(Permissions.canAssignRole(OWNER, manager, "jordan.pike@example.org", ENV)).toBe(false);
  });
  it("rejects Owner-only keys on role save with the agreed wording", () => {
    expect(Permissions.checkRoleKeys(ADMIN, director, ["admin.ai.keys"], ENV)).toBe("Owner only.");
    for (const k of HIDDEN_KEYS) expect(Permissions.checkRoleKeys(ADMIN, director, [k], ENV)).toBe("Not found.");
    expect(Permissions.checkRoleKeys(ADMIN, director, ["project.view"], ENV)).toBeNull();
    expect(Permissions.checkRoleKeys({ ...ADMIN, keys: ["admin.roles"] }, director, ["project.edit"], ENV)).toBe("You can only give permissions you have.");
  });
});

describe("Owner lock", () => {
  it("locks both built-in Owner accounts when OWNER_EMAIL is unset", () => {
    const env = { OWNER_PERSONAL_EMAIL: "owner@example.test" };
    for (const e of OwnerPolicy.defaultOwnerEmails(env)) {
      expect(OwnerLock.isLocked(e, env)).toBe(true);
      expect(OwnerLock.isLocked(` ${e.toUpperCase()} `, env)).toBe(true);
      expect(() => OwnerLock.assertEditable(e, env)).toThrow(OwnerLock.MESSAGE);
    }
    expect(OwnerLock.isLocked("avery.admin@example.org", {})).toBe(false);
    expect(() => OwnerLock.assertEditable("avery.admin@example.org", {})).not.toThrow();
  });
  it("is not a role: no seeded role can carry an Owner-only key or rank at Owner level", () => {
    for (const r of ROLE_DEFAULTS) {
      expect(r.rank).toBeLessThan(100);
      for (const k of r.keys) expect(OWNER_ONLY_KEYS).not.toContain(k);
    }
  });
});

describe("seeded role defaults", () => {
  it("match the matrix counts (yearEnd on demand off everywhere)", () => {
    expect(Object.fromEntries(ROLE_DEFAULTS.map((r) => [r.id, r.keys.length]))).toEqual({ admin: 56, director: 47, manager: 17, editor: 16, viewer: 9 });
    for (const r of ROLE_DEFAULTS) expect(new Set(r.keys).size).toBe(r.keys.length);
  });
  it("seed report.yearEnd.onDemand OFF for every role; only the Owner holds it, and it stays grantable", () => {
    for (const r of ROLE_DEFAULTS) {
      expect(r.keys).not.toContain("report.yearEnd.onDemand");
      expect(Permissions.can({ email: `${r.id}@example.org`, isAdmin: r.id === "admin", roleId: r.id }, "report.yearEnd.onDemand", ENV)).toBe(false);
    }
    expect(Permissions.can(OWNER, "report.yearEnd.onDemand", ENV)).toBe(true);
    expect(GRANTABLE_KEYS).toContain("report.yearEnd.onDemand");
    expect(Permissions.checkRoleKeys(OWNER, { id: "admin", rank: 50, keys: [] }, ["report.yearEnd.onDemand"], ENV)).toBeNull();
  });
  it("spot-check matrix cells", () => {
    expect(roleSeed("director")!.keys).not.toContain("ai.templateAi");
    expect(roleSeed("manager")!.keys.filter((k) => k.startsWith("ai."))).toEqual([]);
    expect(roleSeed("editor")!.keys).toContain("status.change");
    expect(roleSeed("viewer")!.keys).not.toContain("dashboard.item.aiControls");
    expect(roleSeed("admin")!.allLines).toBe(true);
  });
});

describe("migration 0069_roles_permissions (PGlite, example data only)", () => {
  const DIR = path.resolve(__dirname, "../prisma/migrations");
  const folders = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const sql = (f: string) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");
  const migrated = async () => { const db = await PGlite.create(); for (const f of folders) await db.exec(sql(f)); return db; };

  it("is present, add-only, with no em dash", () => {
    expect(folders).toContain("0069_roles_permissions");
    const body = sql("0069_roles_permissions").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/ON (DELETE|UPDATE) (CASCADE|RESTRICT)|BEFORE UPDATE OR DELETE|'[^']*'/g, "");
    expect(body).not.toContain("\u2014");
    expect(body).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b|ALTER COLUMN|UPDATE "/i);
  });
  it("seeds exactly the code defaults and leaves existing people without a role", async () => {
    const db = await migrated();
    const roles = (await db.query<{ id: string; rank: number; allLines: boolean }>(`SELECT id, rank, "allLines" FROM role ORDER BY rank DESC`)).rows;
    expect(roles).toEqual(ROLE_DEFAULTS.map((r) => ({ id: r.id, rank: r.rank, allLines: r.allLines })));
    for (const r of ROLE_DEFAULTS) {
      const keys = (await db.query<{ permission: string }>(`SELECT permission FROM role_permission WHERE "roleId" = $1`, [r.id])).rows.map((x) => x.permission).sort();
      expect(keys).toEqual([...r.keys].sort());
    }
    await db.exec(sql("0069_roles_permissions"));
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM role_permission`)).rows[0].n).toBe(145);
    const col = (await db.query<{ is_nullable: string; column_default: string | null }>(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'app_user' AND column_name = 'roleId'`)).rows[0];
    expect(col).toEqual({ is_nullable: "YES", column_default: null });
  });
  it("refuses Owner-only keys on any role, and history is append-only", async () => {
    const db = await migrated();
    for (const k of OWNER_ONLY_KEYS) await expect(db.query(`INSERT INTO role_permission ("roleId", permission) VALUES ('admin', $1)`, [k])).rejects.toThrow();
    await db.query(`INSERT INTO user_role_history (id, email, "toRoleId", actor) VALUES (gen_random_uuid(), 'eli.editor@example.org', 'editor', 'avery.admin@example.org')`);
    await expect(db.exec(`DELETE FROM user_role_history`)).rejects.toThrow();
    await expect(db.exec(`UPDATE user_role_history SET actor = 'x'`)).rejects.toThrow();
  });
});
