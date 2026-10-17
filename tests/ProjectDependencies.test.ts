import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { BlockerHistory } from "@/lib/projects/BlockerHistory";
import { BlockerRules } from "@/lib/projects/BlockerRules";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import { DependencyGraph, type DependencyEdge } from "@/lib/projects/DependencyGraph";
import {
  BlockerInputError,
  DependencyAccessError,
  DependencyRuleError,
  ProjectDependencyService,
  type DependencyDb,
} from "@/lib/services/ProjectDependencyService";

// Example data only (fictional names and addresses).
const LINE = "00000000-0000-4000-8000-000000000001";
const OTHER_LINE = "00000000-0000-4000-8000-000000000002";
const DEPT_A = "d0000000-0000-4000-8000-00000000000a";
const DEPT_B = "d0000000-0000-4000-8000-00000000000b";
const ADMIN = { email: "admin@example.org", isAdmin: true };
const MEMBER = { email: "member@example.org", isAdmin: false };
const SCOPE = { id: LINE, owners: ["Priya Example"], requesters: [], contractsLeads: ["Jordan Example"] };
const LIMITED = { id: LINE, departmentLimit: [DEPT_A] };
const NOW = new Date("2026-10-17T14:00:00Z");

type P = { id: string; name: string; status: string; serviceLineId: string; departmentId: string | null; archivedAt: Date | null };
type Edge = DependencyEdge & {
  id: string;
  serviceLineId: string;
  createdAt: Date;
  createdBy: string;
  note: string | null;
  blockedMilestoneId: string | null;
  removedAt: Date | null;
  removedBy: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
};
type Blocker = {
  id: string;
  serviceLineId: string;
  projectId: string;
  description: string;
  waitingOn: string;
  since: Date;
  followUpOn: Date | null;
  followUpOwner: string | null;
  blockedMilestoneId: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: string | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date | null;
  updatedBy: string | null;
};
type Step = { id: string; projectId: string; name: string; done: boolean; position: number };
type History = { projectId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: Date; changedBy: string; comment: string | null };

const matches = (r: object, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    const row = r as Record<string, unknown>;
    if (k === "OR") return true;
    if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k]);
    return (row[k] ?? null) === v;
  });

/**
 * In-memory tables with the migration's rules (not self, unique pair, no delete). $transaction snapshots every table
 * and restores it when the callback throws, so "history in the same transaction" is observable: a failure after the
 * row write leaves neither the row nor the history.
 */
class Fake {
  projects: P[] = [];
  edges: Edge[] = [];
  blockers: Blocker[] = [];
  steps: Step[] = [];
  history: History[] = [];
  locks: string[] = [];
  failHistory = false;
  seq = 0;

  constructor() {
    const p = (id: string, name: string, extra: Partial<P> = {}) =>
      this.projects.push({ id, name, status: "OnTrack", serviceLineId: LINE, departmentId: DEPT_A, archivedAt: null, ...extra });
    p("a", "Alpha example");
    p("b", "Bravo example");
    p("c", "Charlie example");
    p("d", "Delta example", { departmentId: DEPT_B });
    p("x", "Other line example", { serviceLineId: OTHER_LINE });
    p("z", "Deleted example", { archivedAt: new Date("2026-10-01T12:00:00Z") });
    this.steps.push({ id: "s1", projectId: "a", name: "Vendor quote", done: false, position: 0 });
    this.steps.push({ id: "s2", projectId: "a", name: "Signed contract", done: true, position: 1 });
    this.steps.push({ id: "s3", projectId: "b", name: "Bravo step", done: false, position: 0 });
  }

  edge(projectId: string, blockedById: string, extra: Partial<Edge> = {}) {
    this.edges.push({ id: `e${++this.seq}`, projectId, blockedById, serviceLineId: LINE, createdAt: new Date("2026-10-10T15:00:00Z"), createdBy: "seed@example.org", note: null, blockedMilestoneId: null, removedAt: null, removedBy: null, updatedAt: null, updatedBy: null, ...extra });
  }

  tables() {
    return {
      project: {
        findUnique: async ({ where }: { where: { id: string } }) => this.projects.find((p) => p.id === where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          this.projects.filter(
            (p) =>
              (where.serviceLineId === undefined || p.serviceLineId === where.serviceLineId) &&
              (where.archivedAt === undefined || p.archivedAt === where.archivedAt) &&
              (!Array.isArray(where.OR) || (where.OR as ({ departmentId: { in: string[] } | null })[]).some((o) => (o.departmentId === null ? p.departmentId === null : o.departmentId.in.includes(p.departmentId ?? "")))),
          ),
        update: async () => {
          throw new Error("project must never be updated by dependency writes");
        },
      },
      projectDependency: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => this.edges.filter((e) => matches(e, where)).map((e) => ({ ...e })),
        findUnique: async ({ where }: { where: { projectId_blockedById: { projectId: string; blockedById: string } } }) => {
          const k = where.projectId_blockedById;
          const e = this.edges.find((x) => x.projectId === k.projectId && x.blockedById === k.blockedById);
          return e ? { ...e } : null;
        },
        create: async ({ data }: { data: Partial<Edge> & DependencyEdge }) => {
          if (data.projectId === data.blockedById) throw new Error("project_dependencies_not_self_check");
          if (this.edges.some((e) => e.projectId === data.projectId && e.blockedById === data.blockedById)) throw new Error("unique project_dependencies_projectId_blockedById_key");
          if ((data.note ?? "").length > 120) throw new Error("project_dependencies_note_length");
          this.edge(data.projectId, data.blockedById, data);
          return data;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Edge> }) => {
          const e = this.edges.find((x) => x.id === where.id)!;
          Object.assign(e, data);
          return e;
        },
        deleteMany: async () => {
          throw new Error("project_dependencies rows are soft-removed, never deleted");
        },
      },
      projectBlocker: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => this.blockers.filter((b) => matches(b, where)).map((b) => ({ ...b })),
        findUnique: async ({ where }: { where: { id: string } }) => {
          const b = this.blockers.find((x) => x.id === where.id);
          return b ? { ...b } : null;
        },
        create: async ({ data }: { data: Omit<Blocker, "id" | "resolvedAt" | "resolvedBy" | "resolution" | "updatedAt" | "updatedBy"> }) => {
          const row: Blocker = { id: `b${++this.seq}`, resolvedAt: null, resolvedBy: null, resolution: null, updatedAt: null, updatedBy: null, ...data };
          this.blockers.push(row);
          return { id: row.id };
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<Blocker> }) => {
          const b = this.blockers.find((x) => x.id === where.id)!;
          Object.assign(b, data);
          return b;
        },
        delete: async () => {
          throw new Error("project_blockers_no_delete");
        },
      },
      projectMilestone: {
        findUnique: async ({ where }: { where: { id: string } }) => this.steps.find((s) => s.id === where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => this.steps.filter((s) => matches(s, where)),
      },
      projectHistory: {
        create: async ({ data }: { data: History }) => {
          if (this.failHistory) throw new Error("history write failed");
          this.history.push({ ...data });
          return data;
        },
      },
      milestoneOwnerName: { findMany: async () => [{ name: "Casey Example" }] },
    };
  }

  db(): DependencyDb & Pick<PrismaClient, "$transaction"> {
    const t = this.tables();
    return {
      ...t,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const snap = JSON.stringify({ e: this.edges, b: this.blockers, h: this.history });
        const revive = (k: string, v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v);
        try {
          return await fn({ ...t, $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (this.locks.push(s.join("?") + v.join(",")), 1) });
        } catch (err) {
          const back = JSON.parse(snap, revive) as { e: Edge[]; b: Blocker[]; h: History[] };
          this.edges = back.e;
          this.blockers = back.b;
          this.history = back.h;
          throw err;
        }
      },
    } as never;
  }
}

const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof DependencyRuleError) return e.problem;
    if (e instanceof BlockerInputError) return e.problem;
    if (e instanceof DependencyAccessError) return "access";
    return String(e);
  }
};
const S = ProjectDependencyService;
const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("DependencyGraph: cycle detection", () => {
  const E = (s: string): DependencyEdge[] => s.split(" ").filter(Boolean).map((x) => ({ projectId: x[0], blockedById: x[1] }));
  it("rejects a self dependency", () => expect(DependencyGraph.check([], "a", "a")).toBe("self"));
  it("rejects a duplicate", () => expect(DependencyGraph.check(E("ab"), "a", "b")).toBe("duplicate"));
  it("rejects a direct cycle (A blocked by B, then B blocked by A)", () => expect(DependencyGraph.check(E("ab"), "b", "a")).toBe("cycle"));
  it("rejects a transitive cycle (A>B>C, then C blocked by A)", () => expect(DependencyGraph.check(E("ab bc"), "c", "a")).toBe("cycle"));
  it("rejects a long transitive cycle through a branch", () => expect(DependencyGraph.check(E("ab ac cd de"), "e", "a")).toBe("cycle"));
  it("allows chains, diamonds and parallel edges that make no cycle", () => {
    expect(DependencyGraph.check(E("ab bc"), "a", "c")).toBeNull();
    expect(DependencyGraph.check(E("ab ac bd"), "c", "d")).toBeNull();
    expect(DependencyGraph.check(E("ab"), "c", "b")).toBeNull();
  });
  it("terminates on a graph that already has a cycle", () => expect(DependencyGraph.reaches(E("ab ba"), "a", "z")).toBe(false));
  it("copy is short and plain (no em dashes)", () => {
    const all = [...Object.values(DependencyGraph.MESSAGES), ...Object.values(BlockerRules.MESSAGES), ...Object.values(DependencyCopy).filter((v): v is string => typeof v === "string"), S.ruleMessage("cycle", "Bravo example")];
    for (const m of all) {
      expect(m).not.toContain("\u2014");
      expect(m.length).toBeLessThan(110);
    }
    expect(S.ruleMessage("cycle", "Bravo example")).toBe("Can't add this. Bravo example already depends on this project, so it would create a loop.");
  });
});

describe("ProjectDependencyService: dependencies (in memory, example data)", () => {
  it("adds with a note and milestone, lists Blocked by and Blocking A to Z, and the picker offers only the others", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "c", { note: "  Waiting on the  vendor quote " }, f.db(), NOW);
    await S.addDependency(ADMIN, SCOPE, "a", "b", { blockedMilestoneId: "s1" }, f.db(), NOW);
    const v = await S.view(ADMIN, SCOPE, "a", f.db(), { now: NOW });
    expect(v.canEdit).toBe(true);
    expect(v.blockedBy.map((r) => [r.project.name, r.note, r.milestone?.name ?? null, r.since])).toEqual([
      ["Bravo example", null, "Vendor quote", "2026-10-17"],
      ["Charlie example", "Waiting on the vendor quote", null, "2026-10-17"],
    ]);
    expect(v.options.map((p) => p.id)).toEqual(["d"]);
    expect(v.milestones.map((m) => m.id)).toEqual(["s1"]); // done steps can't be picked
    expect(v.openCount).toBe(2);
    const b = await S.view(ADMIN, SCOPE, "b", f.db(), { now: NOW });
    expect(b.blocking.map((r) => r.project.name)).toEqual(["Alpha example"]);
    expect(f.edges[0]).toMatchObject({ serviceLineId: LINE, createdBy: ADMIN.email });
    expect(f.locks.every((l) => l.includes("pg_advisory_xact_lock") && l.includes(`project_dependencies:${LINE}`))).toBe(true);
  });

  it("rejects self, duplicate, direct and transitive cycles with the drawer wording and writes nothing", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "b", {}, f.db(), NOW);
    await S.addDependency(ADMIN, SCOPE, "b", "c", {}, f.db(), NOW);
    const before = f.history.length;
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "a", {}, f.db()))).toBe("self");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "b", {}, f.db()))).toBe("duplicate");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "b", "a", {}, f.db()))).toBe("cycle");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "c", "a", {}, f.db()))).toBe("cycle");
    await expect(S.addDependency(ADMIN, SCOPE, "c", "a", {}, f.db())).rejects.toThrow("Can't add this. Alpha example already depends on this project, so it would create a loop.");
    expect(f.edges).toHaveLength(2);
    expect(f.history).toHaveLength(before);
  });

  it("checks cycles against every open edge of the line, even through projects the viewer can't see", async () => {
    const f = new Fake();
    f.edge("a", "d");
    f.edge("d", "b");
    expect(await problem(S.addDependency(ADMIN, LIMITED, "b", "a", {}, f.db()))).toBe("cycle");
  });

  it("soft removal keeps the row, frees the reverse edge, and re-adding the pair revives the same row", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "b", { note: "Old note" }, f.db(), NOW);
    await S.removeDependency(ADMIN, SCOPE, "a", "b", f.db(), NOW);
    expect(f.edges).toHaveLength(1);
    expect(f.edges[0]).toMatchObject({ removedBy: ADMIN.email });
    expect(f.edges[0].removedAt).toEqual(NOW);
    expect((await S.view(ADMIN, SCOPE, "a", f.db())).blockedBy).toEqual([]);
    expect((await S.view(ADMIN, SCOPE, "b", f.db())).blocking).toEqual([]);
    // A removed edge never counts for cycles.
    expect(await problem(S.addDependency(ADMIN, SCOPE, "b", "a", {}, f.db(), NOW))).toBeNull();
    await S.removeDependency(ADMIN, SCOPE, "b", "a", f.db(), NOW);
    await S.addDependency(ADMIN, SCOPE, "a", "b", { note: "New note" }, f.db(), NOW);
    expect(f.edges.filter((e) => e.projectId === "a")).toHaveLength(1);
    expect(f.edges.find((e) => e.projectId === "a")).toMatchObject({ removedAt: null, removedBy: null, note: "New note" });
    // Removing something not open is a quiet no-op.
    const n = f.history.length;
    await S.removeDependency(ADMIN, SCOPE, "c", "b", f.db(), NOW);
    expect(f.history).toHaveLength(n);
  });

  it("note: trimmed, 120 max (warn at 110), and an unknown or other project's milestone is refused", async () => {
    const f = new Fake();
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "b", { note: "x".repeat(121) }, f.db()))).toBe("noteTooLong");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "b", { blockedMilestoneId: "s3" }, f.db()))).toBe("badMilestone");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "b", { blockedMilestoneId: "s2" }, f.db()))).toBe("badMilestone");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "b", { note: "x".repeat(120) }, f.db(), NOW))).toBeNull();
    expect(BlockerRules.counterTone(109)).not.toBe(BlockerRules.counterTone(110));
    expect(BlockerRules.counterTone(110)).toBe(BlockerRules.counterTone(119));
  });

  it("update changes the note and milestone; an unchanged save writes nothing", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "b", {}, f.db(), NOW);
    await S.updateDependency(ADMIN, SCOPE, "a", "b", { note: "Needs the badge feed", blockedMilestoneId: "s1" }, f.db(), NOW);
    const n = f.history.length;
    await S.updateDependency(ADMIN, SCOPE, "a", "b", { note: "Needs the badge feed", blockedMilestoneId: "s1" }, f.db(), NOW);
    expect(f.history).toHaveLength(n);
    expect(f.history.at(-1)!.field).toBe(BlockerHistory.DEPENDENCY_UPDATED);
    expect(JSON.parse(f.history.at(-1)!.newValue!)).toEqual({ projectId: "b", name: "Bravo example", note: "Needs the badge feed", milestone: "Vendor quote" });
  });

  it("access: non-admins, other lines, other departments and deleted projects get the generic denial", async () => {
    const f = new Fake();
    expect(await problem(S.view(MEMBER, SCOPE, "a", f.db()))).toBe("access");
    expect(await problem(S.addDependency(MEMBER, SCOPE, "a", "b", {}, f.db()))).toBe("access");
    expect(await problem(S.removeDependency(MEMBER, SCOPE, "a", "b", f.db()))).toBe("access");
    expect(await problem(S.addBlocker(MEMBER, SCOPE, "a", { description: "x", waitingOn: "y" }, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "x", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "x", "a", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "z", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "z", "a", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, LIMITED, "a", "d", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, LIMITED, "d", "a", {}, f.db()))).toBe("access");
    expect(await problem(S.addDependency(ADMIN, SCOPE, "a", "missing", {}, f.db()))).toBe("access");
    expect(f.edges).toHaveLength(0);
    expect(f.history).toHaveLength(0);
    expect((await S.view(ADMIN, LIMITED, "a", f.db())).options.map((p) => p.id)).toEqual(["b", "c"]);
    expect(new DependencyAccessError().message).toBe("Not found.");
  });

  it("read-only view: same lists, canEdit false, no picker options, people or milestones", async () => {
    const f = new Fake();
    f.edge("a", "b", { note: "Fictional note" });
    f.edge("c", "a");
    await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional vendor quote", waitingOn: "Example Vendor Co" }, f.db(), NOW);
    const v = await S.view(MEMBER, SCOPE, "a", f.db(), { readOnly: true, now: NOW });
    expect(v.canEdit).toBe(false);
    expect(v.blockedBy.map((r) => r.project.id)).toEqual(["b"]);
    expect(v.blocking.map((r) => r.project.id)).toEqual(["c"]);
    expect(v.blockers).toHaveLength(1);
    expect([v.options, v.people, v.milestones]).toEqual([[], [], []]);
    // readOnly never opens a project outside the viewer's scope.
    expect(await problem(S.view(MEMBER, SCOPE, "x", f.db(), { readOnly: true }))).toBe("access");
    expect(await problem(S.view(MEMBER, SCOPE, "z", f.db(), { readOnly: true }))).toBe("access");
  });
});

describe("ProjectDependencyService: external blockers", () => {
  it("adds with since = today (ET), optional follow-up date, owner from the people lists, and milestone", async () => {
    const f = new Fake();
    const late = new Date("2026-10-18T02:30:00Z"); // still Oct 17 in New York
    await S.addBlocker(ADMIN, SCOPE, "a", { description: " Fictional  vendor quote ", waitingOn: "Example Vendor Co", followUpOn: "2026-10-15", followUpOwner: "priya example", blockedMilestoneId: "s1" }, f.db(), late);
    const v = await S.view(ADMIN, SCOPE, "a", f.db(), { now: late });
    expect(v.blockers[0]).toMatchObject({ description: "Fictional vendor quote", waitingOn: "Example Vendor Co", since: "2026-10-17", followUpOn: "2026-10-15", followUpOwner: "Priya Example", milestone: { id: "s1", name: "Vendor quote" } });
    expect(BlockerRules.isFollowUpOverdue(v.blockers[0].followUpOn, v.today)).toBe(true);
    expect(v.people).toContain("Casey Example"); // milestone owner names are offered too
    expect(v.openCount).toBe(1);
  });

  it("refuses missing or long fields, a bad date and an owner not on the lists", async () => {
    const f = new Fake();
    const base = { description: "Fictional", waitingOn: "Example Co" };
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, description: "  " }, f.db()))).toBe("descriptionRequired");
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, description: "x".repeat(201) }, f.db()))).toBe("descriptionTooLong");
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, waitingOn: "" }, f.db()))).toBe("waitingOnRequired");
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, waitingOn: "x".repeat(121) }, f.db()))).toBe("waitingOnTooLong");
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, followUpOn: "2026-02-30" }, f.db()))).toBe("badDate");
    expect(await problem(S.addBlocker(ADMIN, SCOPE, "a", { ...base, followUpOwner: "Somebody Else" }, f.db()))).toBe("unknownOwner");
    expect(f.blockers).toHaveLength(0);
  });

  it("resolve needs 'What resolved it?', keeps the row (Resolved list) and can't run twice", async () => {
    const f = new Fake();
    const id = await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional quote", waitingOn: "Example Co" }, f.db(), NOW);
    expect(await problem(S.resolveBlocker(ADMIN, SCOPE, "a", id, " ", f.db()))).toBe("resolutionRequired");
    expect(await problem(S.resolveBlocker(ADMIN, SCOPE, "a", id, "x".repeat(201), f.db()))).toBe("resolutionTooLong");
    // Resolved by shows the People-list name for the email (as History does).
    await S.resolveBlocker({ email: "pexample@example.org", isAdmin: true }, SCOPE, "a", id, "Quote arrived", f.db(), NOW);
    expect(await problem(S.resolveBlocker(ADMIN, SCOPE, "a", id, "again", f.db()))).toBe("alreadyResolved");
    expect(await problem(S.updateBlocker(ADMIN, SCOPE, "a", id, { description: "x", waitingOn: "y" }, f.db()))).toBe("alreadyResolved");
    expect(await problem(S.resolveBlocker(ADMIN, SCOPE, "b", id, "wrong project", f.db()))).toBe("notFound");
    const v = await S.view(ADMIN, SCOPE, "a", f.db(), { now: NOW });
    expect(v.blockers).toEqual([]);
    expect(v.resolved).toHaveLength(1);
    expect(v.resolved[0]).toMatchObject({ resolution: "Quote arrived", resolvedOn: "2026-10-17", resolvedBy: "Priya Example" });
    expect(f.blockers).toHaveLength(1);
    expect(v.openCount).toBe(0);
  });

  it("update edits fields but never 'since'; an unchanged save writes nothing", async () => {
    const f = new Fake();
    const id = await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional quote", waitingOn: "Example Co" }, f.db(), new Date("2026-10-01T14:00:00Z"));
    await S.updateBlocker(ADMIN, SCOPE, "a", id, { description: "Fictional quote v2", waitingOn: "Example Co", followUpOn: "2026-10-20" }, f.db(), NOW);
    const n = f.history.length;
    await S.updateBlocker(ADMIN, SCOPE, "a", id, { description: "Fictional quote v2", waitingOn: "Example Co", followUpOn: "2026-10-20" }, f.db(), NOW);
    expect(f.history).toHaveLength(n);
    const v = await S.view(ADMIN, SCOPE, "a", f.db(), { now: NOW });
    expect(v.blockers[0]).toMatchObject({ description: "Fictional quote v2", since: "2026-10-01", followUpOn: "2026-10-20" });
  });
});

describe("History rows are written in the same transaction", () => {
  it("every write adds exactly one history row on the blocked project, with a readable timeline sentence", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "b", { note: "Badge feed" }, f.db(), NOW);
    await S.updateDependency(ADMIN, SCOPE, "a", "b", { note: "Badge feed v2" }, f.db(), NOW);
    await S.removeDependency(ADMIN, SCOPE, "a", "b", f.db(), NOW);
    const id = await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional quote", waitingOn: "Example Co" }, f.db(), NOW);
    await S.updateBlocker(ADMIN, SCOPE, "a", id, { description: "Fictional quote", waitingOn: "Example Co Legal" }, f.db(), NOW);
    await S.resolveBlocker(ADMIN, SCOPE, "a", id, "Signed", f.db(), NOW);
    expect(f.history.map((h) => [h.projectId, h.field, h.changedBy])).toEqual(BlockerHistory.FIELDS.map((field) => ["a", field, ADMIN.email]));
    expect(f.history.map((h) => BlockerHistory.text(h.field, h.oldValue, h.newValue, h.comment))).toEqual([
      "Added blocker project Bravo example (waiting on: Badge feed).",
      "Changed blocker project Bravo example (waiting on: Badge feed v2).",
      "Removed blocker project Bravo example.",
      'Added blocker "Fictional quote" (waiting on Example Co).',
      'Changed blocker "Fictional quote" (waiting on Example Co Legal).',
      'Resolved blocker "Fictional quote": Signed.',
    ]);
    for (const t of f.history.map((h) => BlockerHistory.text(h.field, h.oldValue, h.newValue, h.comment)!)) expect(t).not.toContain("\u2014");
  });

  it("a failed history write rolls back the change itself (add, remove, blocker, resolve)", async () => {
    const f = new Fake();
    await S.addDependency(ADMIN, SCOPE, "a", "c", {}, f.db(), NOW);
    const id = await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional quote", waitingOn: "Example Co" }, f.db(), NOW);
    f.failHistory = true;
    await expect(S.addDependency(ADMIN, SCOPE, "a", "b", {}, f.db(), NOW)).rejects.toThrow("history write failed");
    await expect(S.removeDependency(ADMIN, SCOPE, "a", "c", f.db(), NOW)).rejects.toThrow("history write failed");
    await expect(S.addBlocker(ADMIN, SCOPE, "a", { description: "Second", waitingOn: "Example Co" }, f.db(), NOW)).rejects.toThrow("history write failed");
    await expect(S.resolveBlocker(ADMIN, SCOPE, "a", id, "Done", f.db(), NOW)).rejects.toThrow("history write failed");
    expect(f.edges.map((e) => [e.blockedById, e.removedAt])).toEqual([["c", null]]);
    expect(f.blockers.map((b) => [b.id, b.resolvedAt])).toEqual([[id, null]]);
  });

  it("writes never touch the project row and never delete", async () => {
    const f = new Fake();
    const before = JSON.stringify(f.projects);
    await S.addDependency(ADMIN, SCOPE, "a", "b", {}, f.db(), NOW);
    await S.removeDependency(ADMIN, SCOPE, "a", "b", f.db(), NOW);
    const id = await S.addBlocker(ADMIN, SCOPE, "a", { description: "Fictional", waitingOn: "Example" }, f.db(), NOW);
    await S.resolveBlocker(ADMIN, SCOPE, "a", id, "Done", f.db(), NOW);
    expect(JSON.stringify(f.projects)).toBe(before);
    const src = read("src/lib/services/ProjectDependencyService.ts");
    expect(src).not.toMatch(/\.delete(Many)?\(/);
    expect(src).not.toMatch(/project\.update/);
  });
});

describe("Server actions", () => {
  const src = read("src/app/actions/dependencies.ts");
  it("writes are admin-only; load is read-only for others who may open the project (History rule)", () => {
    expect(src).toMatch(/if \(fn && !viewer\.isAdmin\) return \{ ok: false, error: "Not authorized\.", kind: "access" \}/);
    expect(src).toContain("ServiceLineAccess.activeFor(viewer)");
    expect(src).toContain("VisibilityPolicy.isViewable(p, await ViewSettingsService.get(\"dashboard\", Db.client))");
    expect(read("src/lib/services/ProjectDependencyService.ts")).toMatch(/pg_advisory_xact_lock/);
  });
  it("unexpected failures return the plain save error, never the raw error", () => {
    expect(src).toMatch(/error: fn \? DependencyCopy\.SAVE_ERROR : DependencyCopy\.LOAD_ERROR/);
    expect(DependencyCopy.SAVE_ERROR).toBe("Couldn't save your change. Check your connection and try again.");
  });
});

describe("Dependencies stay out of the frozen report path", () => {
  it("no freeze, snapshot, handoff or project service file reads dependencies or blockers", () => {
    for (const f of ["src/lib/services/FreezeService.ts", "src/lib/services/SnapshotService.ts", "src/lib/report/HandoffBuilder.ts", "src/lib/report/pdf/YearEndDocument.tsx", "src/lib/services/ProjectService.ts"]) {
      expect(read(f)).not.toMatch(/projectDependency|project_dependencies|projectBlocker|project_blockers|blockedBy|DependencyGraph/);
    }
  });
});

describe("Drawer section (Figma Bro spec, source checks)", () => {
  const src = read("src/components/DependenciesSection.tsx");
  it("a rejected add marks the picker with the red ring and points at the red alert box", () => {
    expect(src).toMatch(/data-invalid=\{invalid \|\| undefined\}/);
    expect(src).toMatch(/aria-invalid=\{invalid \? true : undefined\}/);
    expect(src).toMatch(/aria-describedby=\{invalid \? errorId : undefined\}/);
    expect(read("src/styles/polish.css")).toMatch(/\.pb-drawer \[data-invalid\] :is\(input, select, textarea\) \{\s*border-color: #ff8a8a/);
  });
  it("reuses the shared pieces: PickerSelect, DueDatePopover, AiAlert", () => {
    for (const m of ["PickerSelect", "DueDatePopover", "AiAlert"]) expect(src).toContain(m);
  });
});
