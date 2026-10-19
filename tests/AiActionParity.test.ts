import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { DateOnly } from "@/lib/domain/DateOnly";
import { AiActionPortsLive } from "@/lib/services/AiActionPortsLive";
import { ProjectService } from "@/lib/services/ProjectService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Item B: an AI apply writes exactly the history a manual edit writes (so Changed, Stale and Updated behave the same),
// plus its source tag. Real ProjectService on the in-memory FakeDb. Example data only.
const scope = () => ServiceLine.defaultScope();
const actor = { changedBy: Factory.ADMIN.email };

async function twin(db: PrismaClient, name: string): Promise<string> {
  const p = await ProjectService.create({ name, serviceArea: "Cath", status: "OnTrack", nextMilestone: "Quote" }, actor, db);
  await ProjectService.saveForm(p.id, {}, Factory.ADMIN, db, { drafts: [
    { id: null, name: "Quote", dueDate: "", done: false, sourceTemplateId: null },
    { id: null, name: "Contract", dueDate: "", done: false, sourceTemplateId: null },
  ] }, scope());
  return p.id;
}

describe("AI apply vs manual edit (FakeDb, real ProjectService)", () => {
  it("same history rows, same public-update fields; the AI rows carry the source tag", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const manual = await twin(db, "Sample parity manual");
    const ai = await twin(db, "Sample parity AI");
    const start = fake.state.history.length;
    const drafts = (id: string): MilestoneDraft[] =>
      fake.state.milestones.filter((m) => m.projectId === id).sort((a, b) => (a.position as number) - (b.position as number))
        .map((s) => ({ id: s.id as string, name: s.name as string, dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "", done: s.name === "Quote" ? true : (s.done as boolean), sourceTemplateId: null }));

    await ProjectService.update(manual, { status: "AtRisk", note: "Quote approved; contract next." }, { changedBy: Factory.ADMIN.email, comment: null }, db, scope());
    await ProjectService.saveMilestones(manual, { drafts: drafts(manual) }, Factory.ADMIN, db, scope());
    await ProjectService.setPeopleField(manual, "contractsLead", "", Factory.ADMIN, db, scope());

    const ports = AiActionPortsLive.of(Factory.ADMIN, scope(), db);
    await ports.update(ai, { status: "AtRisk", note: "Quote approved; contract next." }, "ai:command");
    await ports.saveSteps(ai, drafts(ai), "ai:command");
    await ports.people(ai, "contractsLead", "", "ai:command");

    const rows = (id: string) => fake.state.history.slice(start).filter((h) => h.projectId === id);
    const shape = (id: string) => rows(id).map((h) => [h.field, h.oldValue, h.newValue]).sort((a, b) => String(a).localeCompare(String(b)));
    expect(shape(ai)).toEqual(shape(manual));
    expect(rows(ai).length).toBeGreaterThan(0);
    expect(rows(ai).filter((h) => VisibilityPolicy.isPublicUpdateField(h.field as string)).length).toBe(rows(manual).filter((h) => VisibilityPolicy.isPublicUpdateField(h.field as string)).length);
    expect(rows(ai).every((h) => h.comment === "ai:command")).toBe(true);
    expect(rows(manual).every((h) => h.comment === null)).toBe(true);
    const p = (id: string) => fake.state.projects.find((x) => x.id === id)!;
    expect([p(ai).status, p(ai).nextMilestone, p(ai).note]).toEqual([p(manual).status, p(manual).nextMilestone, p(manual).note]);
  });
});
