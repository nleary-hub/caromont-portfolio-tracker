import { z } from "zod";
import { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ProjectRecord } from "@/lib/domain/types";

/** Editable project fields as received from a form/API. Dates are "YYYY-MM-DD". */
export interface ProjectInput {
  name: string;
  /** Optional "what the project is" text, max AppConfig.DESCRIPTION_MAX_LENGTH. */
  description?: string | null;
  /** Optional Infor request number: whole number 1 to 99999 (a digits-only string is accepted). Blank = null. */
  inforRequestNumber?: number | string | null;
  serviceArea: ServiceArea | string;
  /** Optional; blank = null ("To assign"). */
  owner?: string | null;
  physicianChampion?: string | null;
  physicianChampionEmail?: string | null;
  status: ProjectStatus | string;
  nextMilestone?: string | null;
  dueDate?: string | null;
  targetCompletion?: string | null;
  percentComplete?: number | null;
  note?: string | null;
  /** Optional, max AppConfig.ACCOMPLISHMENT_MAX_LENGTH. Blank = null. */
  accomplishment?: string | null;
  /** Optional "YYYY-MM-DD". Display only. */
  completedOn?: string | null;
  includeInReport?: boolean;
}

/** Normalized, validated, Prisma-ready project fields. */
export interface ProjectData {
  name: string;
  description: string | null;
  inforRequestNumber: number | null;
  serviceArea: ServiceArea;
  owner: string | null;
  physicianChampion: string | null;
  physicianChampionEmail: string | null;
  status: ProjectStatus;
  nextMilestone: string | null;
  dueDate: Date | null;
  targetCompletion: Date | null;
  percentComplete: number | null;
  note: string | null;
  accomplishment: string | null;
  completedOn: Date | null;
  includeInReport: boolean;
}

export type FieldErrors = Partial<Record<keyof ProjectInput | "_form", string[]>>;

export type ValidationResult =
  | { ok: true; data: ProjectData }
  | { ok: false; errors: FieldErrors };

export class ProjectValidationError extends Error {
  constructor(readonly errors: FieldErrors) {
    super(
      "Project validation failed: " +
        Object.entries(errors)
          .map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`)
          .join("; "),
    );
    this.name = "ProjectValidationError";
  }
}

export class ProjectValidator {
  static readonly MILESTONE_REQUIRED_MESSAGE =
    "Next milestone is required unless the project is Not started, On hold, Complete or Cancelled";

  static readonly NOTE_MAX = AppConfig.NOTE_MAX_LENGTH;
  static readonly NAME_MAX = AppConfig.SHORT_TEXT_MAX_LENGTH;
  static readonly MILESTONE_MAX = AppConfig.MILESTONE_MAX_LENGTH;
  static readonly DESCRIPTION_MAX = AppConfig.DESCRIPTION_MAX_LENGTH;
  static readonly INFOR_MIN = AppConfig.INFOR_REQUEST_NUMBER_MIN;
  static readonly INFOR_MAX = AppConfig.INFOR_REQUEST_NUMBER_MAX;
  static readonly INFOR_MESSAGE = `Infor request number must be a whole number from ${AppConfig.INFOR_REQUEST_NUMBER_MIN} to ${AppConfig.INFOR_REQUEST_NUMBER_MAX}`;

  /**
   * Infor request number from form/CSV input: null/undefined/blank = null; a number or a digits-only
   * string (surrounding whitespace allowed) = that number; anything else (decimals, letters, signs,
   * "4656 / 5081") = undefined. Range is checked separately.
   */
  static parseInforNumber(value: unknown): number | null | undefined {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
    if (typeof value !== "string") return undefined;
    const t = value.trim();
    if (t === "") return null;
    return /^[0-9]+$/.test(t) ? Number(t) : undefined;
  }

  private static readonly schema = ProjectValidator.buildSchema();

  /** Validate and normalize a full set of editable fields. */
  static validate(input: unknown): ValidationResult {
    const parsed = ProjectValidator.schema.safeParse(input);
    if (parsed.success) return { ok: true, data: parsed.data };
    const errors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = (issue.path[0] as keyof FieldErrors | undefined) ?? "_form";
      (errors[key] ??= []).push(issue.message);
    }
    return { ok: false, errors };
  }

  /** Like validate() but throws ProjectValidationError. */
  static parse(input: unknown): ProjectData {
    const result = ProjectValidator.validate(input);
    if (!result.ok) throw new ProjectValidationError(result.errors);
    return result.data;
  }

  /** Convert a stored project back to input form (used to merge a partial update before validation). */
  static toInput(project: ProjectRecord): ProjectInput {
    return {
      name: project.name,
      description: project.description,
      inforRequestNumber: project.inforRequestNumber,
      serviceArea: project.serviceArea,
      owner: project.owner,
      physicianChampion: project.physicianChampion,
      physicianChampionEmail: project.physicianChampionEmail,
      status: project.status,
      nextMilestone: project.nextMilestone,
      dueDate: DateOnly.fromDbDate(project.dueDate),
      targetCompletion: DateOnly.fromDbDate(project.targetCompletion),
      percentComplete: project.percentComplete,
      note: project.note,
      accomplishment: project.accomplishment,
      completedOn: DateOnly.fromDbDate(project.completedOn),
      includeInReport: project.includeInReport,
    };
  }

  private static optionalText(max?: { label: string; length: number }) {
    const base = max ? z.string().max(max.length, `${max.label} must be at most ${max.length} characters`) : z.string();
    return z.preprocess(
      (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null),
      base.nullable(),
    );
  }

  private static requiredText(label: string, max: number) {
    return z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z
        .string({ error: `${label} is required` })
        .min(1, `${label} is required`)
        .max(max, `${label} must be at most ${max} characters`),
    );
  }

  private static optionalDate(label: string) {
    return z.preprocess(
      (v) => {
        if (v === undefined || v === null || v === "") return null;
        if (v instanceof Date) return Number.isNaN(v.getTime()) ? v : DateOnly.fromDbDate(v);
        return v;
      },
      z
        .string()
        .refine((s) => DateOnly.isIso(s), `${label} must be a valid date (YYYY-MM-DD)`)
        .transform((s) => DateOnly.toDbDate(s))
        .nullable(),
    );
  }

  private static buildSchema() {
    return z
      .object({
        name: ProjectValidator.requiredText("Name", ProjectValidator.NAME_MAX),
        description: ProjectValidator.optionalText({
          label: "Description",
          length: ProjectValidator.DESCRIPTION_MAX,
        }),
        inforRequestNumber: z.preprocess(
          (v) => {
            const n = ProjectValidator.parseInforNumber(v);
            return n === undefined ? Number.NaN : n;
          },
          z
            .number({ error: ProjectValidator.INFOR_MESSAGE })
            .int(ProjectValidator.INFOR_MESSAGE)
            .min(ProjectValidator.INFOR_MIN, ProjectValidator.INFOR_MESSAGE)
            .max(ProjectValidator.INFOR_MAX, ProjectValidator.INFOR_MESSAGE)
            .nullable(),
        ),
        serviceArea: z.enum(ServiceArea, { error: "Service area must be one of the defined areas" }),
        owner: ProjectValidator.optionalText({ label: "Owner", length: ProjectValidator.NAME_MAX }),
        physicianChampion: ProjectValidator.optionalText(),
        physicianChampionEmail: z.preprocess(
          (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v ?? null),
          z.email("Physician champion email is not a valid email").nullable(),
        ),
        status: z.enum(ProjectStatus, { error: "Status must be one of the defined statuses" }),
        nextMilestone: ProjectValidator.optionalText({
          label: "Next milestone",
          length: ProjectValidator.MILESTONE_MAX,
        }),
        dueDate: ProjectValidator.optionalDate("Due date"),
        targetCompletion: ProjectValidator.optionalDate("Target completion"),
        percentComplete: z.preprocess(
          (v) => (v === undefined || v === "" ? null : v),
          z
            .number({ error: "Percent complete must be a number" })
            .int("Percent complete must be a whole number")
            .min(0, "Percent complete must be between 0 and 100")
            .max(100, "Percent complete must be between 0 and 100")
            .nullable(),
        ),
        note: z.preprocess(
          (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null),
          z
            .string()
            .max(ProjectValidator.NOTE_MAX, `Note must be at most ${ProjectValidator.NOTE_MAX} characters`)
            .nullable(),
        ),
        accomplishment: ProjectValidator.optionalText({
          label: "Accomplishment",
          length: AppConfig.ACCOMPLISHMENT_MAX_LENGTH,
        }),
        completedOn: ProjectValidator.optionalDate("Completed on"),
        includeInReport: z.boolean().default(true),
      })
      .superRefine((p, ctx) => {
        if (!ProjectStatusInfo.milestoneOptional(p.status) && !p.nextMilestone) {
          ctx.addIssue({
            code: "custom",
            path: ["nextMilestone"],
            message: ProjectValidator.MILESTONE_REQUIRED_MESSAGE,
          });
        }
      });
  }
}
