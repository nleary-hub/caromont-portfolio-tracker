import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import { DependencyGraph, type DependencyEdge } from "@/lib/projects/DependencyGraph";
import { DependencyAccessError, DependencyRuleError, ProjectDependencyService, type DependencyDb } from "@/lib/services/ProjectDependencyService";

// Example data only.
const LINE = "00000000-0000-4000-8000-000000000001";
const OTHER_LINE = "00000000-0000-4000-8000-000000000002";
const DEPT_A = "d0000000-0000-4000-8000-00000000000a";
const DEPT_B = "d0000000-0000-4000-8000-00000000000b";
const ADMIN = { email: "admin@example.org", isAdmin: true };
const MEMBER = { email: "member@example.org", isAdmin: false };
const SCOPE = { id: LINE };
const LIMITED = { id: LINE, departmentLimit: [DEPT_A] };

type P = { id: string; name: string; serviceLineId: string; departmentId: string | null; archivedAt: Date | null };

/** In-memory project and project_dependencies with the migration's self and unique rules. */
class Fake {
  projects: P[] = [];
  edges: (DependencyEdge & { serviceLineId: string; createdBy: string })[] = [];

  constructor() {
    const p = (id: string, name: string, extra: Partial<P> = {}) => this.projects.push({ id, name, serviceLineId: LINE, departmentId: DEPT_A, archivedAt: null, ...extra });
    p("a", "Alpha example");
    p("b", "Bravo example");
    p("c", "Charlie example");
    p("d", "Delta example", { departmentId: DEPT_B });
    p("x", "Other line example", { serviceLineId: OTHER_LINE });
    p("z", "Deleted example", { archivedAt: new Date("2026-10-01T12:00:00Z") });
  }

  db(): DependencyDb {
    const match = (p: P, w: Record<string, unknown>) =>
      (w.serviceLineId === undefined || p.serviceLineId === w.serviceLineId) &&
      (w.archivedAt === undefined || p.archivedAt === w.archivedAt) &&
      (!Array.isArray(w.OR) || (w.OR as { departmentId: { in: string[] } | null }[]).some((o) => (o.departmentId === null ? p.departmentId === null : o.departmentId.in.includes(p.departmentId ?? ""))));
    const em = (e: Fake["edges"][number], w: Record<string, string>) => Object.entries(w).every(([k, v]) => (e as unknown as Record<string, string>)[k] === v);
    return {
      project: {
        findUnique: async ({ where }: { where: { id: string } }) => this.projects.find((p) => p.id === where.id) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => this.projects.filter((p) => match(p, where)),
      },
      projectDependency: {
        findMany: async ({ where }: { where: Record<string, string> }) => this.edges.filter((e) => em(e, where)),
        create: async ({ data }: { data: Fake["edges"][number] }) => {
          if (data.projectId === data.blockedById) throw new Error("project_dependencies_not_self_check");
          if (this.edges.some((e) => e.projectId === data.projectId && e.blockedById === data.blockedById)) throw new Error("unique project_dependencies_projectId_blockedById_key");
          this.edges.push({ ...data });
          return data;
        },
        deleteMany: async ({ where }: { where: Record<string, string> }) => {
          const before = this.edges.length;
          this.edges = this.edges.filter((e) => !em(e, where));
          return { count: before - this.edges.length };
        },
      },
    } as unknown as DependencyDb;
  }
}

const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DependencyRuleError ? e.problem : e instanceof DependencyAccessError ? "access" : String(e);
  }
};

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
  it("messages are short and plain (no em dashes)", () => {
    for (const m of [...Object.values(DependencyGraph.MESSAGES), DependencyCopy.TITLE, DependencyCopy.NONE, DependencyCopy.count(2)]) {
      expect(m).not.toContain("\u2014");
      expect(m.length).toBeLessThan(110);
    }
  });
});

describe("ProjectDependencyService: rules and access (in memory, example data)", () => {
  it("adds and lists blockers A to Z, and the picker offers only the others", async () => {
    const f = new Fake();
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "c", f.db());
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "b", f.db());
    const v = await ProjectDependencyService.view(ADMIN, SCOPE, "a", f.db());
    expect(v.blockedBy.map((p) => p.name)).toEqual(["Bravo example", "Charlie example"]);
    expect(v.options.map((p) => p.id)).toEqual(["d"]);
    expect(f.edges[0]).toMatchObject({ serviceLineId: LINE, createdBy: ADMIN.email });
  });

  it("rejects self, duplicate, direct and transitive cycles with a clear error and writes nothing", async () => {
    const f = new Fake();
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "b", f.db());
    await ProjectDependencyService.add(ADMIN, SCOPE, "b", "c", f.db());
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "a", "a", f.db()))).toBe("self");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "a", "b", f.db()))).toBe("duplicate");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "b", "a", f.db()))).toBe("cycle");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "c", "a", f.db()))).toBe("cycle");
    expect(f.edges).toHaveLength(2);
    await expect(ProjectDependencyService.add(ADMIN, SCOPE, "c", "a", f.db())).rejects.toThrow(DependencyGraph.MESSAGES.cycle);
  });

  it("checks cycles against every edge of the line, even through projects the viewer can't see", async () => {
    const f = new Fake();
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "d", f.db()); // d is in another department
    f.edges.push({ projectId: "d", blockedById: "b", serviceLineId: LINE, createdBy: "admin@example.org" });
    expect(await problem(ProjectDependencyService.add(ADMIN, LIMITED, "b", "a", f.db()))).toBe("cycle");
  });

  it("removing an edge then allows the reverse edge", async () => {
    const f = new Fake();
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "b", f.db());
    await ProjectDependencyService.remove(ADMIN, SCOPE, "a", "b", f.db());
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "b", "a", f.db()))).toBeNull();
  });

  it("access: non-admins, other lines, other departments and deleted projects get the generic denial", async () => {
    const f = new Fake();
    expect(await problem(ProjectDependencyService.view(MEMBER, SCOPE, "a", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(MEMBER, SCOPE, "a", "b", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.remove(MEMBER, SCOPE, "a", "b", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "a", "x", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "x", "a", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "a", "z", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "z", "a", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, LIMITED, "a", "d", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, LIMITED, "d", "a", f.db()))).toBe("access");
    expect(await problem(ProjectDependencyService.add(ADMIN, SCOPE, "a", "missing", f.db()))).toBe("access");
    expect(f.edges).toHaveLength(0);
    // The limited view offers only projects inside the viewer's departments.
    expect((await ProjectDependencyService.view(ADMIN, LIMITED, "a", f.db())).options.map((p) => p.id)).toEqual(["b", "c"]);
    expect(new DependencyAccessError().message).toBe("Not found.");
  });

  it("the server actions re-check admin and use the generic denial", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/app/actions/dependencies.ts"), "utf8");
    expect(src).toMatch(/if \(!viewer\?\.isAdmin\) return \{ ok: false, error: "Not authorized\." \}/);
    expect(src).toContain("ServiceLineAccess.activeFor(viewer)");
    expect(src).toContain("addLocked");
    expect(read("src/lib/services/ProjectDependencyService.ts")).toMatch(/pg_advisory_xact_lock/);
  });
});

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");

describe("Dependencies stay out of the report", () => {
  it("no report, PDF, freeze, snapshot or handoff file reads dependencies", () => {
    for (const f of ["src/lib/services/FreezeService.ts", "src/lib/services/SnapshotService.ts", "src/lib/report/ReportDataLoader.ts", "src/lib/report/HandoffBuilder.ts", "src/lib/report/ReportBuilder.ts", "src/lib/report/pdf/ReportDocument.tsx", "src/lib/report/pdf/YearEndDocument.tsx", "src/lib/services/ProjectService.ts"]) {
      expect(read(f)).not.toMatch(/projectDependency|project_dependencies|blockedBy|DependencyGraph/);
    }
  });
});

describe("Dependencies picker error state (Figma Bro nit)", () => {
  const src = read("src/components/DependenciesEditor.tsx");
  it("a rejected add marks the picker invalid with the drawer error border and points at the error", () => {
    expect(src).toMatch(/data-invalid=\{invalid \|\| undefined\}/);
    expect(src).toMatch(/aria-invalid=\{invalid \? true : undefined\}/);
    expect(src).toMatch(/aria-describedby=\{invalid \? errorId : undefined\}/);
    expect(src).toMatch(/errorId=\{`dep-\$\{projectId\}-error`\}/);
    expect(src).toMatch(/<p id=\{`dep-\$\{projectId\}-error`\} role="alert"/);
    expect(src).toMatch(/invalid=\{Boolean\(error\) && addError\}/);
    expect(src).toMatch(/run\(actions\.add\(projectId, p\.id\), true\)/);
    expect(read("src/styles/polish.css")).toMatch(/\.pb-drawer \[data-invalid\] :is\(input, select, textarea\) \{\s*border-color: #ff8a8a/);
  });
  it("typing in the field clears the error", () => {
    expect(src).toMatch(/setQuery\(e\.target\.value\);\s*onType\?\.\(\);/);
    expect(src).toMatch(/onType=\{\(\) => \{\s*if \(addError\) \{\s*setError\(null\);\s*setAddError\(false\);/);
  });
});

describe("Adding or removing a dependency never changes the project", () => {
  it("only reads projects (no update, no updatedAt, no Changed) and writes no history row", async () => {
    const f = new Fake();
    const base = f.db() as unknown as Record<string, Record<string, unknown>>;
    const calls: string[] = [];
    const guard = new Proxy(base, {
      get(t, table: string) {
        if (table !== "project" && table !== "projectDependency") throw new Error(`unexpected table ${table}`);
        return new Proxy(t[table], { get: (d, m: string) => (calls.push(`${table}.${m}`), d[m]) });
      },
    }) as unknown as DependencyDb;
    const before = JSON.stringify(f.projects);
    await ProjectDependencyService.add(ADMIN, SCOPE, "a", "b", guard);
    await ProjectDependencyService.remove(ADMIN, SCOPE, "a", "b", guard);
    expect(JSON.stringify(f.projects)).toBe(before);
    expect(calls.filter((c) => c.startsWith("project.")).every((c) => c === "project.findUnique" || c === "project.findMany")).toBe(true);
    expect(calls).not.toContain("projectHistory.create");
  });
});
