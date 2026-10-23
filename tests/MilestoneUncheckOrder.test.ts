import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";

// Regression: unchecking the last milestone of a Complete project with no next milestone, from the drawer checklist,
// failed on real Postgres. The status went back to On track before the next milestone was written, which the
// Project CHECK constraint refuses. Real Prisma over PGlite (every migration applied) so the constraint is the real one.
// Private port, not the shared e2e 5439.
const PORT = 5493;
const DIR = path.resolve(__dirname, "../prisma/migrations");
let pg: PGlite;
let server: PGLiteSocketServer;
let db: PrismaClient;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const f of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await pg.exec(readFileSync(path.join(DIR, f, "migration.sql"), "utf8"));
  server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1" });
  await server.start();
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 1 }) });
}, 60000);

afterAll(async () => {
  await db?.$disconnect();
  await server?.stop();
  await pg?.close();
});

describe("drawer checklist: unchecking the last milestone of a Complete project", () => {
  it("writes the next milestone before the status, so a project with none reopens to On track", async () => {
    const p = await db.project.create({ data: { name: "Harbor Valve Registry", status: "Complete", completedOn: new Date("2026-10-20"), nextMilestone: null, updatedBy: "e2e@example.org" } });
    const a = await db.projectMilestone.create({ data: { projectId: p.id, name: "Kickoff", done: true, doneAt: new Date("2026-10-01"), position: 0 } });
    const b = await db.projectMilestone.create({ data: { projectId: p.id, name: "Go-live", done: true, doneAt: new Date("2026-10-20"), position: 1 } });
    const drafts = [
      { id: a.id, name: "Kickoff", dueDate: "", done: true, sourceTemplateId: null, owner: null },
      { id: b.id, name: "Go-live", dueDate: "", done: false, sourceTemplateId: null, owner: null },
    ];
    await ProjectService.saveMilestones(p.id, { drafts }, Factory.ADMIN as never, db, ServiceLine.defaultScope());
    const after = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("OnTrack");
    expect(after.nextMilestone).toBe("Go-live");
    expect(after.completedOn).toBeNull();
  }, 60000);

  it("checking the final milestone still completes an On track project", async () => {
    const p = await db.project.create({ data: { name: "Lumen Intake Board", status: "OnTrack", nextMilestone: "Go-live", updatedBy: "e2e@example.org" } });
    const a = await db.projectMilestone.create({ data: { projectId: p.id, name: "Go-live", done: false, position: 0 } });
    await ProjectService.saveMilestones(p.id, { drafts: [{ id: a.id, name: "Go-live", dueDate: "", done: true, sourceTemplateId: null, owner: null }] }, Factory.ADMIN as never, db, ServiceLine.defaultScope());
    const after = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("Complete");
  }, 60000);
});
