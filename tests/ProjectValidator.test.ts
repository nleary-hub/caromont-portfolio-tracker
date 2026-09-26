import { describe, expect, it } from "vitest";
import { AppConfig } from "@/lib/config/AppConfig";
import { ProjectValidationError, ProjectValidator } from "@/lib/validation/ProjectValidator";

const base = {
  name: "Radial lounge expansion",
  serviceArea: "Cath",
  owner: "Owner B",
  status: "OnTrack",
  nextMilestone: "Construction bid award",
};

describe("ProjectValidator", () => {
  it("accepts a valid project and normalizes fields", () => {
    const r = ProjectValidator.validate({
      ...base,
      name: "  Radial lounge expansion  ",
      physicianChampion: "",
      physicianChampionEmail: " Dr.B@Example.org ",
      dueDate: "2026-10-03",
      percentComplete: 40,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.name).toBe("Radial lounge expansion");
    expect(r.data.physicianChampion).toBeNull();
    expect(r.data.physicianChampionEmail).toBe("dr.b@example.org");
    expect(r.data.dueDate?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(r.data.includeInReport).toBe(true);
    expect(r.data.note).toBeNull();
  });

  it("uses the single config constant for the note limit (200)", () => {
    expect(AppConfig.NOTE_MAX_LENGTH).toBe(200);
    expect(ProjectValidator.NOTE_MAX).toBe(AppConfig.NOTE_MAX_LENGTH);
  });

  it("allows a note of exactly 200 chars and rejects 201", () => {
    expect(ProjectValidator.validate({ ...base, note: "x".repeat(200) }).ok).toBe(true);
    const r = ProjectValidator.validate({ ...base, note: "x".repeat(201) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.note?.[0]).toMatch(/200/);
  });

  it("requires nextMilestone unless Complete or Cancelled", () => {
    for (const status of ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold"]) {
      const r = ProjectValidator.validate({ ...base, status, nextMilestone: "   " });
      expect(r.ok, status).toBe(false);
      if (!r.ok) expect(r.errors.nextMilestone).toBeDefined();
    }
    for (const status of ["Complete", "Cancelled"]) {
      expect(ProjectValidator.validate({ ...base, status, nextMilestone: null }).ok, status).toBe(true);
    }
  });

  it("enforces percentComplete 0-100 integers", () => {
    expect(ProjectValidator.validate({ ...base, percentComplete: 0 }).ok).toBe(true);
    expect(ProjectValidator.validate({ ...base, percentComplete: 100 }).ok).toBe(true);
    expect(ProjectValidator.validate({ ...base, percentComplete: null }).ok).toBe(true);
    expect(ProjectValidator.validate({ ...base, percentComplete: -1 }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, percentComplete: 101 }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, percentComplete: 50.5 }).ok).toBe(false);
  });

  it("accepts only enum values for serviceArea and status", () => {
    expect(ProjectValidator.validate({ ...base, serviceArea: "Cardiology" }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, status: "Done" }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, serviceArea: "cath" }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, serviceArea: "CardioNeuro" }).ok).toBe(true);
  });

  it("requires name, treats a blank owner as unassigned, and rejects invalid dates/emails", () => {
    const r = ProjectValidator.validate({ ...base, name: "", owner: " " });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBeDefined();
      expect(r.errors.owner).toBeUndefined();
    }
    const blank = ProjectValidator.validate({ ...base, owner: "  " });
    expect(blank.ok && blank.data.owner).toBeNull();
    const missing = ProjectValidator.validate({ ...base, owner: undefined });
    expect(missing.ok && missing.data.owner).toBeNull();
    expect(ProjectValidator.validate({ ...base, dueDate: "2026-02-30" }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, physicianChampionEmail: "not-an-email" }).ok).toBe(false);
  });

  it("parse() throws ProjectValidationError", () => {
    expect(() => ProjectValidator.parse({ ...base, note: "x".repeat(201) })).toThrow(ProjectValidationError);
  });

  it("limits next milestone to AppConfig.MILESTONE_MAX_LENGTH (40) characters on every save", () => {
    expect(AppConfig.MILESTONE_MAX_LENGTH).toBe(40);
    expect(ProjectValidator.validate({ ...base, nextMilestone: "m".repeat(40) }).ok).toBe(true);
    // Surrounding whitespace is trimmed before the length check.
    expect(ProjectValidator.validate({ ...base, nextMilestone: `  ${"m".repeat(40)}  ` }).ok).toBe(true);
    const r = ProjectValidator.validate({ ...base, nextMilestone: "m".repeat(41) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.nextMilestone).toEqual(["Next milestone must be at most 40 characters"]);
  });

  it("description is optional (blank or missing = null) and limited to AppConfig.DESCRIPTION_MAX_LENGTH (200)", () => {
    expect(AppConfig.DESCRIPTION_MAX_LENGTH).toBe(200);
    for (const description of [undefined, null, "", "   "]) {
      const r = ProjectValidator.validate({ ...base, description });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.description).toBeNull();
    }
    const ok = ProjectValidator.validate({ ...base, description: `  ${"d".repeat(200)}  ` });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.description).toBe("d".repeat(200));
    const r = ProjectValidator.validate({ ...base, description: "d".repeat(201) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.description).toEqual(["Description must be at most 200 characters"]);
  });
});
