import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { AuditText } from "@/lib/admin/AuditText";
import { ClosedPageData } from "@/lib/closed/ClosedPageData";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";
import { ReopenRules } from "@/lib/closed/ReopenRules";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { CompletionCopy } from "@/lib/projects/CompletionCopy";
import { roleSeed } from "@/lib/permissions/RoleDefaults";
import { ProjectNotCompleteError, ProjectService } from "@/lib/services/ProjectService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

// Roles & Permissions PR 5: reopen a completed project (matrix 4.3) and the status.change check on a form save.
beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", "admin@example.org");
});

const OWNERS = ["Kim Nguyen", "Priya Shah"];
const scope = () => ({ ...ServiceLine.defaultScope(), owners: OWNERS });
const actor = { changedBy: "admin@example.org" };
const as = (roleId: string, email: string) => ({ email, isAdmin: false, roleId, rank: roleSeed(roleId)!.rank, keys: [...roleSeed(roleId)!.keys] });
const DIRECTOR = as("director", "dana.fieldstone@example.org");
const EDITOR = as("editor", "eli.marsh@example.org");
const NO_STATUS = { ...as("editor", "sam.quill@example.org"), keys: roleSeed("editor")!.keys.filter((k) => k !== "status.change") };

class Setup {
  fake = new FakeDb();
  db: PrismaClient = this.fake.asClient();
  steps(id: string) {
    return this.fake.state.milestones.filter((m) => m.projectId === id).sort((a, b) => (a.position as number) - (b.position as number));
  }
  drafts(id: string): MilestoneDraft[] {
    return this.steps(id).map((s) => ({ id: s.id as string, name: s.name as string, dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "", done: s.done as boolean, sourceTemplateId: (s.sourceTemplateId as string | null) ?? null, owner: (s.owner as string | null | undefined) ?? null }));
  }
  project(id: string) {
    return this.fake.state.projects.find((p) => p.id === id)!;
  }
  history(id: string, field?: string) {
    return this.fake.state.history.filter((h) => h.projectId === id && (!field || h.field === field));
  }
  /** A project that was At risk, then completed by checking its last milestone. */
  async completed(): Promise<string> {
    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Vendor quote", dueDate: "2026-10-03" }, actor, this.db);
    await ProjectService.saveMilestones(p.id, { drafts: [{ id: null, name: "Vendor quote", dueDate: "", done: false, sourceTemplateId: null }, { id: null, name: "Go-live", dueDate: "", done: false, sourceTemplateId: null }] }, Factory.ADMIN, this.db, scope());
    await ProjectService.saveForm(p.id, { status: "AtRisk" }, Factory.ADMIN, this.db, null, scope());
    await ProjectService.saveMilestones(p.id, { drafts: this.drafts(p.id).map((d) => ({ ...d, done: true })) }, Factory.ADMIN, this.db, scope());
    expect(this.project(p.id).status).toBe("Complete");
    return p.id;
  }
}

describe("ReopenRules", () => {
  const row = (oldValue: string | null, newValue: string, at: string) => ({ field: "status", oldValue, newValue, changedAt: new Date(at) });
  it("goes back to the status before the latest completion, else On track", () => {
    expect(ReopenRules.target([row("OnTrack", "AtRisk", "2026-09-01T12:00:00Z"), row("AtRisk", "Complete", "2026-09-10T12:00:00Z")])).toEqual({ status: "AtRisk", fromHistory: true });
    expect(ReopenRules.target([])).toEqual({ status: "OnTrack", fromHistory: false });
  });
  it("needs a reason of 1 to 500 characters", () => {
    expect(ReopenRules.reason("  Vendor recall  ")).toBe("Vendor recall");
    expect(ReopenRules.reason("   ")).toBeNull();
    expect(ReopenRules.reason("x".repeat(501))).toBeNull();
    expect(ReopenRules.reason(42)).toBeNull();
  });
});

describe("ProjectService.reopenCompleted", () => {
  it("unchecks the project's last milestone, clears the date, restores the earlier status and audits it", async () => {
    const s = new Setup();
    const id = await s.completed();
    const lastId = s.steps(id).at(-1)!.id;
    const { target } = await ProjectService.reopenCompleted(id, "Vendor recall on the closure kit", DIRECTOR as never, s.db, scope(), new Date("2026-10-20T14:00:00Z"));
    expect(target).toEqual({ status: "AtRisk", fromHistory: true });
    const steps = s.steps(id);
    expect(steps.find((m) => m.id === lastId)!.done).toBe(false);
    expect(steps.find((m) => m.id === lastId)!.doneAt ?? null).toBeNull();
    expect(steps[0].done).toBe(true);
    const p = s.project(id);
    expect(p.status).toBe("AtRisk");
    expect(p.completedAtAuto ?? null).toBeNull();
    expect(p.completedOn ?? null).toBeNull();
    expect(s.history(id, "status").at(-1)).toMatchObject({ oldValue: "Complete", newValue: "AtRisk", changedBy: DIRECTOR.email });
    expect(s.history(id, "milestone_reopened").length).toBe(1);
    expect(s.history(id, "completion").at(-1)!.comment).toBe("completion:reopened_unchecked");
    const audit = s.history(id, ReopenRules.AUDIT_FIELD);
    expect(audit).toHaveLength(1);
    const detail = JSON.parse(audit[0].newValue as string);
    expect(detail).toMatchObject({ actor: DIRECTOR.email, actorRole: "director", projectId: id, milestoneId: lastId, milestoneName: "Go-live", restoredStatus: "AtRisk", reason: "Vendor recall on the closure kit" });
    expect(detail.priorCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(AuditText.change({ kind: "project", field: ReopenRules.AUDIT_FIELD, oldValue: null, newValue: null })).toBe("Project reopened");
    expect(AuditText.summary({ kind: "project", field: ReopenRules.AUDIT_FIELD, oldValue: audit[0].oldValue as string, newValue: audit[0].newValue as string }, "new")).toBe("Back to At risk. Unchecked Go-live. Role: director. Reason: Vendor recall on the closure kit");
  });

  it("refuses without the key, without a reason, and on a project that is not Complete", async () => {
    const s = new Setup();
    const id = await s.completed();
    await expect(ProjectService.reopenCompleted(id, "Recall", EDITOR as never, s.db, scope())).rejects.toBeInstanceOf(AdminRequiredError);
    await expect(ProjectService.reopenCompleted(id, "  ", DIRECTOR as never, s.db, scope())).rejects.toMatchObject({ errors: { _form: [ClosedPagesCopy.REOPEN_REASON_REQUIRED] } });
    expect(s.project(id).status).toBe("Complete");
    expect(s.history(id, ReopenRules.AUDIT_FIELD)).toHaveLength(0);
    await ProjectService.reopenCompleted(id, "Recall", DIRECTOR as never, s.db, scope());
    await expect(ProjectService.reopenCompleted(id, "Again", DIRECTOR as never, s.db, scope())).rejects.toBeInstanceOf(ProjectNotCompleteError);
  });

  it("falls back to On track with no earlier status on record", async () => {
    const s = new Setup();
    const p = await ProjectService.create({ name: "Echo lab refresh", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Install", dueDate: "2026-10-03" }, actor, s.db);
    await ProjectService.saveMilestones(p.id, { drafts: [{ id: null, name: "Install", dueDate: "", done: true, sourceTemplateId: null }] }, Factory.ADMIN, s.db, scope());
    const { target } = await ProjectService.reopenCompleted(p.id, "Install failed inspection", Factory.ADMIN, s.db, scope());
    expect(target.status).toBe("OnTrack");
    expect(s.project(p.id).status).toBe("OnTrack");
  });

  it("reopen previews name the last done milestone and the status", () => {
    const at = new Date("2026-09-10T12:00:00Z");
    const out = ClosedPageData.reopenPreviews(["p1"], [{ projectId: "p1", field: "status", oldValue: "OnHold", newValue: "Complete", changedAt: at }], [
      { projectId: "p1", name: "Kickoff", done: true, position: 1 },
      { projectId: "p1", name: "Go-live", done: true, position: 2 },
    ]);
    expect(out.p1).toEqual({ statusLabel: "On hold", fromHistory: true, milestone: "Go-live" });
    expect(ClosedPagesCopy.reopenBody("Go-live", "On hold", true)).toBe("\"Go-live\" is unchecked, the completion date is cleared and it goes back to On hold. Past reports don't change.");
  });
});

describe("status.change on a form save (matrix 4.1)", () => {
  it("a role without status.change can save other fields but not change the status", async () => {
    const s = new Setup();
    const p = await ProjectService.create({ name: "Cath lab 3", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid", dueDate: "2026-10-03" }, actor, s.db);
    await expect(ProjectService.saveForm(p.id, { status: "AtRisk" }, NO_STATUS as never, s.db, null, scope())).rejects.toBeInstanceOf(AdminRequiredError);
    expect(s.project(p.id).status).toBe("OnTrack");
    // An unchanged status in the payload is not a status change.
    await ProjectService.saveForm(p.id, { status: "OnTrack", note: "Bids due Friday" }, NO_STATUS as never, s.db, null, scope());
    expect(s.project(p.id).note).toBe("Bids due Friday");
  });

  it("Editor (status.change by default) can change the status", async () => {
    const s = new Setup();
    const p = await ProjectService.create({ name: "Cath lab 4", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Bid", dueDate: "2026-10-03" }, actor, s.db);
    await ProjectService.saveForm(p.id, { status: "OnHold" }, EDITOR as never, s.db, null, scope());
    expect(s.project(p.id).status).toBe("OnHold");
  });

  it("the edit form shows the status read-only without the key", async () => {
    const { ProjectEditForm } = await import("@/components/ProjectEditForm");
    const { ProjectFormModel } = await import("@/lib/projects/ProjectFormModel");
    const original = { ...ProjectFormModel.empty("2026-10-23"), name: "Cath lab 5", status: "OnTrack" };
    const props = { mode: "edit", original, milestones: [], templates: [], ownerOptions: [], onSubmit: async () => ({ ok: true, id: "x" }), onCancel: () => {} } as never;
    const locked = renderToStaticMarkup(createElement(ProjectEditForm, { ...(props as object), canChangeStatus: false } as never));
    expect(locked).toContain('data-testid="status-readonly"');
    expect(locked).toContain(CompletionCopy.STATUS_LOCKED_NOTE.replace("'", "&#x27;"));
    expect(locked).not.toContain('data-testid="status-picker"');
    const open = renderToStaticMarkup(createElement(ProjectEditForm, props));
    expect(open).toContain('data-testid="status-picker"');
  });
});
