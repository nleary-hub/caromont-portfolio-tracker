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

  it("requires name and owner and rejects invalid dates/emails", () => {
    const r = ProjectValidator.validate({ ...base, name: "", owner: " " });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.name).toBeDefined();
      expect(r.errors.owner).toBeDefined();
    }
    expect(ProjectValidator.validate({ ...base, dueDate: "2026-02-30" }).ok).toBe(false);
    expect(ProjectValidator.validate({ ...base, physicianChampionEmail: "not-an-email" }).ok).toBe(false);
  });

  it("parse() throws ProjectValidationError", () => {
    expect(() => ProjectValidator.parse({ ...base, note: "x".repeat(201) })).toThrow(ProjectValidationError);
  });
});
