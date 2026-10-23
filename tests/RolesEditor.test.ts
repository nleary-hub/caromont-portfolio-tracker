import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GRANTABLE_KEYS, HIDDEN_KEYS, OWNER_ONLY_KEYS, ROLE_DEFAULTS, VISIBLE_LOCKED_KEYS } from "@/lib/permissions";
import { RoleEditPolicy } from "@/lib/permissions/RoleEditPolicy";
import { KEY_LABELS } from "@/lib/permissions/RoleLabels";
import { RoleService, type RoleTxDb, type RolesData } from "@/lib/services/RoleService";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/actions/roles", () => ({ saveRoleKeys: vi.fn(), createRole: vi.fn(), deleteRole: vi.fn(), duplicateRole: vi.fn(), renameRole: vi.fn() }));

// Roles & Permissions PR 3: the Roles editor's rank rule, grant limit, Owner lock, history and delete flow.
// Fictional people only.
const ENV = { OWNER_EMAIL: "jordan.pike@example.org", ADMIN_EMAILS: "jordan.pike@example.org casey.lund@example.org" };
const seed = (id: string) => ROLE_DEFAULTS.find((r) => r.id === id)!;
const OWNER = { email: "jordan.pike@example.org", isAdmin: true };
const ADMIN = { email: "casey.lund@example.org", isAdmin: true, roleId: "admin", rank: 50, keys: [...seed("admin").keys] };
const DIRECTOR = { email: "noor.bellamy@example.org", isAdmin: false, roleId: "director", rank: 40, keys: [...seed("director").keys, "admin.roles"] };
const EDITOR = { email: "ivo.kestrel@example.org", isAdmin: false, roleId: "editor", rank: 20, keys: [...seed("editor").keys] };
const role = (id: string, keys: readonly string[] = seed(id).keys) => ({ id, rank: seed(id).rank, keys: [...keys] });

describe("rank rule", () => {
  it("lets you edit only roles strictly below your own rank", () => {
    expect(RoleEditPolicy.canEdit(ADMIN, role("director"), ENV)).toBe(true);
    expect(RoleEditPolicy.canEdit(ADMIN, role("admin"), ENV)).toBe(false);
    expect(RoleEditPolicy.canEdit(DIRECTOR, role("director"), ENV)).toBe(false);
    expect(RoleEditPolicy.canEdit(DIRECTOR, role("manager"), ENV)).toBe(true);
    expect(RoleEditPolicy.canEdit(OWNER, role("admin"), ENV)).toBe(true);
  });
  it("refuses anyone without admin.roles, even on a lower role", () => {
    expect(RoleEditPolicy.canOpen(EDITOR, ENV)).toBe(false);
    expect(RoleEditPolicy.checkSave(EDITOR, role("viewer"), seed("viewer").keys, ENV)).toBe("Not found.");
  });
  it("refuses a save on your own rank or above", () => {
    expect(RoleEditPolicy.checkSave(ADMIN, role("admin"), seed("admin").keys, ENV)).toBe("Not found.");
    expect(RoleEditPolicy.checkSave(DIRECTOR, role("director"), seed("director").keys, ENV)).toBe("Not found.");
  });
  it("only offers roles below your own as move targets", () => {
    const all = ROLE_DEFAULTS.map((r) => ({ id: r.id, rank: r.rank }));
    expect(RoleEditPolicy.assignable(ADMIN, all, ENV).map((r) => r.id)).toEqual(["director", "manager", "editor", "viewer"]);
    expect(RoleEditPolicy.assignable(DIRECTOR, all, ENV).map((r) => r.id)).toEqual(["manager", "editor", "viewer"]);
  });
});

describe("grant limit", () => {
  it("lets you add only permissions you have, with the agreed message", () => {
    expect(RoleEditPolicy.checkSave(DIRECTOR, role("manager"), [...seed("manager").keys, "project.hide"], ENV)).toBeNull();
    expect(RoleEditPolicy.checkSave(DIRECTOR, role("manager"), [...seed("manager").keys, "admin.settings"], ENV)).toBe("You can only give permissions you have.");
    expect(RoleEditPolicy.GRANT_LIMIT_MESSAGE).toBe("You can only give permissions you have.");
  });
  it("allows removing a permission you don't hold", () => {
    const withSettings = role("manager", [...seed("manager").keys, "admin.settings"]);
    expect(RoleEditPolicy.checkSave(DIRECTOR, withSettings, seed("manager").keys, ENV)).toBeNull();
  });
  it("keeps a permission the role already has when you don't hold it", () => {
    const withSettings = role("manager", [...seed("manager").keys, "admin.settings"]);
    expect(RoleEditPolicy.checkSave(DIRECTOR, withSettings, withSettings.keys, ENV)).toBeNull();
  });
  it("marks grantable keys per actor: the Owner and Admin can give every grantable key, a Director only theirs", () => {
    expect(RoleEditPolicy.grantableKeys(OWNER, ENV)).toEqual([...GRANTABLE_KEYS]);
    expect(RoleEditPolicy.grantableKeys(ADMIN, ENV).sort()).toEqual([...seed("admin").keys].sort());
    expect(RoleEditPolicy.grantableKeys(DIRECTOR, ENV)).not.toContain("admin.settings");
    expect(RoleEditPolicy.grantableKeys(DIRECTOR, ENV)).toContain("project.delete");
  });
});

describe("Owner lock", () => {
  it("never lets anyone, the Owner included, store an Owner-only key on a role", () => {
    for (const actor of [OWNER, ADMIN]) {
      for (const k of HIDDEN_KEYS) expect(RoleEditPolicy.checkSave(actor, role("viewer"), [k], ENV)).toBe("Not found.");
      expect(RoleEditPolicy.checkSave(actor, role("viewer"), ["admin.ai.keys"], ENV)).toBe("Owner only.");
      for (const k of OWNER_ONLY_KEYS) expect(RoleEditPolicy.canGrant(actor, k, ENV)).toBe(false);
    }
  });
  it("refuses unknown keys as Not found.", () => {
    expect(RoleEditPolicy.checkSave(OWNER, role("viewer"), ["made.up"], ENV)).toBe("Not found.");
  });
  it("labels exactly the 58 visible keys and none of the hidden ones", () => {
    expect(Object.keys(KEY_LABELS).sort()).toEqual([...GRANTABLE_KEYS, ...VISIBLE_LOCKED_KEYS].sort());
    for (const k of HIDDEN_KEYS) expect(k in KEY_LABELS).toBe(false);
    expect(KEY_LABELS["admin.ai.keys"].helper).toBe("Owner only.");
  });
});

/** A small in-memory stand-in for the Prisma calls RoleService makes. */
function fakeDb(initial: { roles: { id: string; name: string; rank: number; isSystem: boolean; keys: string[]; description?: string | null }[]; users: { email: string; name: string | null; roleId: string | null }[] }) {
  const roles = initial.roles.map((r) => ({ ...r, description: r.description ?? null, allLines: false, keys: [...r.keys] }));
  const users = initial.users.map((u) => ({ ...u }));
  const roleHistory: { roleId: string; action: string; detail: unknown; actor: string }[] = [];
  const userRoleHistory: { email: string; fromRoleId: string | null; toRoleId: string | null }[] = [];
  const shape = (r: (typeof roles)[number]) => ({ ...r, permissions: r.keys.map((permission) => ({ permission })) });
  const nameMatch = (n: string, where: { name: { equals: string } }) => n.toLowerCase() === where.name.equals.toLowerCase();
  const db = {
    role: {
      findUnique: async ({ where }: { where: { id: string } }) => { const r = roles.find((x) => x.id === where.id); return r ? shape(r) : null; },
      findFirst: async ({ where }: { where: { name: { equals: string }; NOT?: { id: string } } }) => roles.find((r) => nameMatch(r.name, where) && r.id !== where.NOT?.id) ?? null,
      findMany: async () => roles.map(shape),
      create: async ({ data }: { data: (typeof roles)[number] }) => { roles.push({ ...data, keys: [] }); return data; },
      update: async ({ where, data }: { where: { id: string }; data: { name: string; description: string | null } }) => Object.assign(roles.find((r) => r.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => roles.splice(roles.findIndex((r) => r.id === where.id), 1),
    },
    rolePermission: {
      deleteMany: async ({ where }: { where: { roleId: string; permission: { in: string[] } } }) => { const r = roles.find((x) => x.id === where.roleId)!; r.keys = r.keys.filter((k) => !where.permission.in.includes(k)); },
      createMany: async ({ data }: { data: { roleId: string; permission: string }[] }) => { for (const d of data) roles.find((x) => x.id === d.roleId)!.keys.push(d.permission); },
    },
    roleHistory: {
      create: async ({ data }: { data: (typeof roleHistory)[number] }) => roleHistory.push(data),
      update: async () => { throw new Error("append-only"); },
      delete: async () => { throw new Error("append-only"); },
    },
    userRoleHistory: { createMany: async ({ data }: { data: typeof userRoleHistory }) => userRoleHistory.push(...data) },
    appUser: {
      findUnique: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null,
      findMany: async ({ where }: { where?: { roleId: string } } = {}) => users.filter((u) => !where || u.roleId === where.roleId),
      updateMany: async ({ where, data }: { where: { roleId: string }; data: { roleId: string } }) => { for (const u of users) if (u.roleId === where.roleId) u.roleId = data.roleId; },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { db: db as unknown as RoleTxDb, roles, users, roleHistory, userRoleHistory };
}

const systemRoles = () => ROLE_DEFAULTS.map((r) => ({ id: r.id, name: r.name, rank: r.rank, isSystem: true, keys: [...r.keys] }));

describe("RoleService (server checks through the engine, append-only history)", () => {
  it("saves a key change below your rank and appends one history row", async () => {
    const f = fakeDb({ roles: systemRoles(), users: [] });
    const res = await RoleService.saveKeys(ADMIN, "editor", [...seed("editor").keys, "project.create"], f.db, ENV);
    expect(res).toEqual({ ok: true, message: "Saved." });
    expect(f.roles.find((r) => r.id === "editor")!.keys).toContain("project.create");
    expect(f.roleHistory).toEqual([{ id: expect.any(String), roleId: "editor", action: "keys", detail: { added: ["project.create"], removed: [] }, actor: ADMIN.email }]);
  });
  it("refuses the grant limit, the rank rule and Owner-only keys without writing anything", async () => {
    const f = fakeDb({ roles: systemRoles(), users: [] });
    expect(await RoleService.saveKeys(DIRECTOR, "manager", [...seed("manager").keys, "admin.import"], f.db, ENV)).toEqual({ ok: false, message: "You can only give permissions you have." });
    expect(await RoleService.saveKeys(ADMIN, "admin", [], f.db, ENV)).toEqual({ ok: false, message: "Not found." });
    expect(await RoleService.saveKeys(OWNER, "viewer", ["report.freeze"], f.db, ENV)).toEqual({ ok: false, message: "Not found." });
    expect(await RoleService.saveKeys(OWNER, "viewer", ["admin.ai.keys"], f.db, ENV)).toEqual({ ok: false, message: "Owner only." });
    expect(f.roleHistory).toEqual([]);
    expect(f.roles.find((r) => r.id === "manager")!.keys).toEqual([...seed("manager").keys]);
  });
  it("creates, renames and duplicates custom roles below the actor, each with a history row", async () => {
    const f = fakeDb({ roles: systemRoles(), users: [] });
    const made = await RoleService.create(ADMIN, "Report reviewer", "Reads reports only", f.db, ENV);
    expect(made.ok).toBe(true);
    const id = (made as { roleId: string }).roleId;
    expect(f.roles.find((r) => r.id === id)).toMatchObject({ name: "Report reviewer", rank: 15, isSystem: false, description: "Reads reports only" });
    expect((await RoleService.create(ADMIN, "report REVIEWER", "", f.db, ENV)).ok).toBe(false);
    expect((await RoleService.create(ADMIN, "Owner", "", f.db, ENV)).ok).toBe(false);
    expect((await RoleService.rename(ADMIN, id, "Report checker", "Checks reports", f.db, ENV)).ok).toBe(true);
    expect((await RoleService.duplicate(ADMIN, "editor", f.db, ENV)).ok).toBe(true);
    expect(f.roles.find((r) => r.name === "Editor copy")!.keys.sort()).toEqual([...seed("editor").keys].sort());
    expect((await RoleService.duplicate(ADMIN, "admin", f.db, ENV)).ok).toBe(false);
    expect(f.roleHistory.map((h) => h.action)).toEqual(["create", "rename", "create"]);
  });
  it("delete-confirm flow: moves holders to a lower role first, logs both histories, and never deletes system roles", async () => {
    const f = fakeDb({
      roles: [...systemRoles(), { id: "custom-rr", name: "Report reviewer", rank: 15, isSystem: false, keys: ["report.view"] }],
      users: [
        { email: "noor.bellamy@example.org", name: "Noor Bellamy", roleId: "custom-rr" },
        { email: "ivo.kestrel@example.org", name: "Ivo Kestrel", roleId: "custom-rr" },
      ],
    });
    expect(await RoleService.remove(ADMIN, "custom-rr", null, f.db, ENV)).toEqual({ ok: false, message: "Pick a role to move these users to." });
    expect(await RoleService.remove(ADMIN, "custom-rr", "admin", f.db, ENV)).toEqual({ ok: false, message: "You can assign roles below your own." });
    expect(await RoleService.remove(ADMIN, "viewer", "editor", f.db, ENV)).toEqual({ ok: false, message: "System roles can't be deleted." });
    expect(f.roleHistory).toEqual([]);
    expect(await RoleService.remove(ADMIN, "custom-rr", "viewer", f.db, ENV)).toEqual({ ok: true, message: "Role deleted." });
    expect(f.users.map((u) => u.roleId)).toEqual(["viewer", "viewer"]);
    expect(f.userRoleHistory.map((h) => [h.email, h.fromRoleId, h.toRoleId])).toEqual([["noor.bellamy@example.org", "custom-rr", "viewer"], ["ivo.kestrel@example.org", "custom-rr", "viewer"]]);
    expect(f.roleHistory).toEqual([{ id: expect.any(String), roleId: "custom-rr", action: "delete", detail: { name: "Report reviewer", movedTo: "viewer", moved: 2 }, actor: ADMIN.email }]);
    expect(f.roles.some((r) => r.id === "custom-rr")).toBe(false);
  });
  it("only ever inserts into role_history (no update or delete calls in the service)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/services/RoleService.ts", "utf8");
    expect(src).not.toMatch(/roleHistory\.(update|delete|upsert)/);
    expect(src).not.toMatch(/userRoleHistory\.(update|delete|upsert)/);
  });
  it("resolves the actor from the database: env admin is Admin, Owner is the fixed identity", async () => {
    const f = fakeDb({ roles: systemRoles(), users: [{ email: "riley.moss@example.org", name: "Riley Moss", roleId: "editor" }] });
    expect(await RoleService.actorFor(OWNER, f.db, ENV)).toEqual(OWNER);
    expect(await RoleService.actorFor({ email: "casey.lund@example.org", isAdmin: true }, f.db, ENV)).toMatchObject({ roleId: "admin", rank: 50 });
    expect(await RoleService.actorFor({ email: "riley.moss@example.org", isAdmin: false }, f.db, ENV)).toMatchObject({ roleId: "editor", rank: 20 });
  });
});

describe("Roles editor render", () => {
  it("shows 58 key rows, admin.ai.keys locked with no switch, and no hidden key or freeze wording", async () => {
    const { RolesEditor } = await import("@/components/RolesEditor");
    const f = fakeDb({ roles: systemRoles(), users: [] });
    const data: RolesData = await RoleService.load(ADMIN, f.db, ENV);
    const html = renderToStaticMarkup(createElement(RolesEditor, { data, initialRoleId: "editor" }));
    expect(html.match(/data-testid="key-/g)).toHaveLength(58);
    expect(html).toMatch(/data-testid="key-admin\.ai\.keys" data-locked="true"/);
    expect(html.match(/role="switch"/g)).toHaveLength(57);
    for (const k of HIDDEN_KEYS) expect(html).not.toContain(k);
    expect(html).not.toMatch(/freeze|frozen|snapshot|handoff|delivery/i);
    expect(html).not.toContain("\u2014");
    expect(html).toContain("58 permission keys in 7 groups.");
  });
});
