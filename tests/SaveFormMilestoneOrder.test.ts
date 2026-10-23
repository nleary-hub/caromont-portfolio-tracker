import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ProjectService } from "@/lib/services/ProjectService";

// Roles & Permissions 5b: the drawer edit form (ProjectService.saveForm) as an Editor. Pins the write order: the next
// milestone is stored before (or with) the status change, so the Project CHECK constraint never sees a reopened
// project without one. Real Prisma over PGlite with every migration applied. Private port, not the shared e2e 5439.
const PORT = 5494;
const DIR = path.resolve(__dirname, "../prisma/migrations");
const EDITOR = { email: "morgan.hale@example.org", isAdmin: false, roleId: "editor" };
const EDITOR_NO_STATUS = { ...EDITOR, keys: ["project.view", "project.edit"] };
let pg: PGlite;
let server: PGLiteSocketServer;
let base: PrismaClient;
const writes: { status?: unknown; nextMilestone?: unknown }[] = [];

/** The client with every Project update recorded in order (status and nextMilestone only). */
const recorded = () =>
  base.$extends({
    query: {
      project: {
        async update({ args, query }) {
          const d = args.data as Record<string, unknown>;
          writes.push({ ...("status" in d ? { status: d.status } : {}), ...("nextMilestone" in d ? { nextMilestone: d.nextMilestone } : {}) });
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const f of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await pg.exec(readFileSync(path.join(DIR, f, "migration.sql"), "utf8"));
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  base = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 1 }) });
}, 60000);

afterAll(async () => {
  await base?.$disconnect();
  await server?.stop();
  await pg?.close();
});

const completeProject = async (name: string) => {
  const p = await base.project.create({ data: { name, status: "Complete", completedOn: new Date("2026-10-20"), nextMilestone: null, updatedBy: "e2e@example.org" } });
  const a = await base.projectMilestone.create({ data: { projectId: p.id, name: "Kickoff", done: true, doneAt: new Date("2026-10-01"), position: 0 } });
  const b = await base.projectMilestone.create({ data: { projectId: p.id, name: "Go-live", done: true, doneAt: new Date("2026-10-20"), position: 1 } });
  const drafts = [
    { id: a.id, name: "Kickoff", dueDate: "", done: true, sourceTemplateId: null, owner: null },
    { id: b.id, name: "Go-live", dueDate: "", done: false, sourceTemplateId: null, owner: null },
  ];
  return { p, drafts };
};

describe("saveForm as an Editor: next milestone before status", () => {
  it("unchecking the last step and moving a Complete project to At risk stores Go-live as next milestone first", async () => {
    const { p, drafts } = await completeProject("Harbor Valve Registry");
    writes.length = 0;
    await ProjectService.saveForm(p.id, { status: "AtRisk" } as never, EDITOR as never, recorded(), { drafts, applied: null }, ServiceLine.defaultScope());
    const after = await base.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("AtRisk");
    expect(after.nextMilestone).toBe("Go-live");
    expect(after.completedOn).toBeNull();
    // Order pin: the first write that moves the status off Complete already carries the next milestone, or one before it did.
    const firstStatus = writes.findIndex((w) => w.status !== undefined && w.status !== "Complete");
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    const milestoneBefore = writes.slice(0, firstStatus + 1).some((w) => w.nextMilestone === "Go-live");
    expect(milestoneBefore).toBe(true);
  }, 60000);

  it("an Editor without status.change can still edit fields but can't change the status", async () => {
    const p = await base.project.create({ data: { name: "Lumen Intake Board", status: "OnTrack", nextMilestone: "Go-live", updatedBy: "e2e@example.org" } });
    await ProjectService.saveForm(p.id, { inforRequestNumber: "4821" } as never, EDITOR_NO_STATUS as never, base, null, ServiceLine.defaultScope());
    expect((await base.project.findUniqueOrThrow({ where: { id: p.id } })).inforRequestNumber).toBe(4821);
    await expect(ProjectService.saveForm(p.id, { status: "AtRisk" } as never, EDITOR_NO_STATUS as never, base, null, ServiceLine.defaultScope())).rejects.toThrow();
    expect((await base.project.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("OnTrack");
  }, 60000);

  it("a Viewer can't save the form at all", async () => {
    const p = await base.project.create({ data: { name: "Cedar Scheduling Hub", status: "OnTrack", nextMilestone: "Go-live", updatedBy: "e2e@example.org" } });
    await expect(ProjectService.saveForm(p.id, { owner: "Pat Ellis" } as never, { email: "riley.moss@example.org", isAdmin: false, roleId: "viewer" } as never, base, null, ServiceLine.defaultScope())).rejects.toThrow();
  }, 60000);
});
