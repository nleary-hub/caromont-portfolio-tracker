import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DependencyReviewCopy, DependencyReviewIntro, DependencyReviewTable } from "@/components/DependencyReviewTable";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { DependencyReviewService, type DependencyDb } from "@/lib/services/ProjectDependencyService";

// Fictional data only.
const LINE = "00000000-0000-4000-8000-000000000001";
const OTHER_LINE = "00000000-0000-4000-8000-000000000002";
const DEPT_A = "d0000000-0000-4000-8000-00000000000a";
const DEPT_B = "d0000000-0000-4000-8000-00000000000b";
const ADMIN = { email: "fictional.admin@example.org", isAdmin: true };
const MEMBER = { email: "fictional.member@example.org", isAdmin: false };

type Row = { id: string; serviceLineId: string; createdAt: Date; createdBy: string; project: { name: string; departmentId: string | null }; blockedBy: { name: string; departmentId: string | null } };

/** In-memory project_dependencies. Any write method records itself, so the test can prove the list never writes. */
function fake(rows: Row[]) {
  const writes: string[] = [];
  const calls: unknown[] = [];
  const write = (name: string) => async () => {
    writes.push(name);
    throw new Error("write not allowed");
  };
  const db = {
    projectDependency: {
      findMany: async (args: { where: { serviceLineId: string }; orderBy: unknown }) => {
        calls.push(args);
        return rows.filter((r) => r.serviceLineId === args.where.serviceLineId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
      },
      create: write("create"), createMany: write("createMany"), update: write("update"), updateMany: write("updateMany"), delete: write("delete"), deleteMany: write("deleteMany"), upsert: write("upsert"),
    },
    project: { update: write("project.update"), updateMany: write("project.updateMany") },
  } as unknown as DependencyDb;
  return { db, writes, calls };
}

const ROWS: Row[] = [
  { id: "r1", serviceLineId: LINE, createdAt: new Date("2026-10-09T19:40:00Z"), createdBy: ADMIN.email, project: { name: "Alpha fictional project", departmentId: DEPT_A }, blockedBy: { name: "Zulu fictional project", departmentId: DEPT_A } },
  { id: "r2", serviceLineId: LINE, createdAt: new Date("2026-10-14T13:12:00Z"), createdBy: ADMIN.email, project: { name: "Zulu fictional project", departmentId: DEPT_A }, blockedBy: { name: "Bravo fictional project", departmentId: null } },
  { id: "r3", serviceLineId: LINE, createdAt: new Date("2026-10-01T15:00:00Z"), createdBy: ADMIN.email, project: { name: "Sample Clinic refresh", departmentId: DEPT_B }, blockedBy: { name: "Alpha fictional project", departmentId: DEPT_A } },
  { id: "r4", serviceLineId: OTHER_LINE, createdAt: new Date("2026-10-15T15:00:00Z"), createdBy: ADMIN.email, project: { name: "Other line example", departmentId: null }, blockedBy: { name: "Example Lab move", departmentId: null } },
];

describe("Admin > Dependencies review (read only)", () => {
  it("lists the active line's rows newest first with project, blocked by, added and added by; writes nothing", async () => {
    const { db, writes, calls } = fake(ROWS);
    const out = await DependencyReviewService.list(ADMIN, { id: LINE }, db);
    expect(out).toEqual([
      { id: "r2", project: "Zulu fictional project", blockedBy: "Bravo fictional project", createdAt: new Date("2026-10-14T13:12:00Z"), createdBy: ADMIN.email },
      { id: "r1", project: "Alpha fictional project", blockedBy: "Zulu fictional project", createdAt: new Date("2026-10-09T19:40:00Z"), createdBy: ADMIN.email },
      { id: "r3", project: "Sample Clinic refresh", blockedBy: "Alpha fictional project", createdAt: new Date("2026-10-01T15:00:00Z"), createdBy: ADMIN.email },
    ]);
    expect(calls).toMatchObject([{ where: { serviceLineId: LINE, removedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] }]);
    expect(writes).toEqual([]);
  });

  it("a department-limited admin sees only rows whose two projects are inside their access; a non-admin sees none", async () => {
    const { db, writes } = fake(ROWS);
    expect((await DependencyReviewService.list(ADMIN, { id: LINE, departmentLimit: [DEPT_A] }, db)).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(await DependencyReviewService.list(MEMBER, { id: LINE }, db)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("the table renders rows with no button, link, form or input; empty state and count", () => {
    const html = renderToStaticMarkup(createElement(DependencyReviewTable, { rows: [{ id: "r2", project: "Zulu fictional project", blockedBy: "Bravo fictional project", created: "Oct 14, 2026, 9:12 AM ET", createdBy: ADMIN.email }] }));
    for (const h of DependencyReviewCopy.HEADERS) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain("Zulu fictional project");
    expect(html).toContain("1 dependency");
    expect(html).not.toMatch(/<(button|a|form|input|select|textarea)\b/);
    expect(html).not.toMatch(/<h[1-6]\b/);
    expect(html).not.toContain("Blocked-by dependencies");
    const empty = renderToStaticMarkup(createElement(DependencyReviewTable, { rows: [] }));
    expect(empty).toContain(DependencyReviewCopy.EMPTY);
    expect(empty).not.toContain("dependency-review-count");
  });

  it("intro: the exact Writing Bot copy, capped at 72ch", () => {
    expect(DependencyReviewCopy.INTRO).toBe(
      "Every Blocked-by dependency in this service line, newest first. The list is read only. Some older rows were saved by a removed AI tool and may not be real dependencies. To fix one, open that project's drawer and edit it under Dependencies.",
    );
    const html = renderToStaticMarkup(createElement(DependencyReviewIntro));
    expect(html).toContain('class="max-w-[72ch] text-muted type-caption"');
    expect(html).toContain("The list is read only.");
    expect(html).not.toContain("Link button");
    expect(readFileSync("src/app/admin/dependencies/page.tsx", "utf8")).toContain("<DependencyReviewIntro />");
  });

  it("the page is admin-only (404 otherwise), imports no actions, and has an admin menu link", () => {
    const page = readFileSync("src/app/admin/dependencies/page.tsx", "utf8");
    expect(page).toContain('if (!viewer || !Permissions.can(viewer, "project.review")) notFound();');
    expect(page).not.toMatch(/@\/app\/actions|"use server"|<form|<button/);
    expect(AdminMenu.definitions().find((d) => d.id === "dependencies")).toMatchObject({ group: "admin", kind: "link", href: "/admin/dependencies", label: "Dependencies review", shipped: true });
    expect(AdminMenu.itemsFor(MEMBER)).toBeNull();
  });

  it("copy has no em dashes", () => {
    const src = readFileSync("src/components/DependencyReviewTable.tsx", "utf8") + readFileSync("src/app/admin/dependencies/page.tsx", "utf8");
    expect(src).not.toContain("\u2014");
  });
});
