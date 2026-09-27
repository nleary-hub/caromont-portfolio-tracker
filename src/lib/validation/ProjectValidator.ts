import { Requester } from "@/lib/domain/Requester";
import { z } from "zod";
import { ProjectStatus } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ProjectRecord } from "@/lib/domain/types";
import { ServiceLine } from "@/lib/domain/ServiceLine";

/** Editable project fields as received from a form/API. Dates are "YYYY-MM-DD". */
export interface ProjectInput {
  name: string;
  /** Optional "what the project is" text, max AppConfig.DESCRIPTION_MAX_LENGTH. */
  description?: string | null;
  /** Optional Infor request number: whole number 1 to 99999 (a digits-only string is accepted). Blank = null. */
  inforRequestNumber?: number | string | null;
  /** Blank, null or "Unassigned" = no department. */
  serviceArea?: DepartmentKey | string | null;
  /** Optional; blank = null ("To assign"). */
  owner?: string | null;
  physicianChampion?: string | null;
  physicianChampionEmail?: string | null;
  requesterNotApplicable?: boolean;
  /** One of the service line's contracts leads (case/space tolerant) or blank. */
  contractsLead?: string | null;
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
  serviceArea: DepartmentKey | null;
  owner: string | null;
  physicianChampion: string | null;
  physicianChampionEmail: string | null;
  requesterNotApplicable: boolean;
  contractsLead: string | null;
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

/** Per-field messages; "milestones" carries checklist errors from the drawer ("Step 3: At most 40 characters"). */
export type FieldErrors = Partial<Record<keyof ProjectInput | "_form" | "milestones", string[]>>;

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

/**
 * How the drawer edit form validates (ProjectValidator.validateForm). The CSV import and wording
 * update keep the default rules (hard 40-character milestone).
 */
export interface FormValidationOptions {
  /**
   * The stored project for an edit (null for a new project). A capped text field whose value equals
   * the stored value is not length-checked, so an existing over-cap value never blocks a save of other
   * fields; it must be shortened only when that field is edited.
   */
  existing: ProjectInput | null;
  /** The service line's pick-lists (defaults to the default line's). */
  rules?: LineRules;
}

/**
 * Per service line rules: the contracts lead pick-list and the departments the line uses. A stored value that
 * is no longer on the list is accepted while it is unchanged, so trimming a list never blocks other edits.
 */
export interface LineRules {
  contractsLeads: readonly string[];
  /** The line's departments not deleted (archived ones flagged): only open ones can be newly chosen. */
  departments: DepartmentList;
}

export class ProjectValidator {
  static readonly DEPARTMENT_NOT_IN_LINE_MESSAGE = "Department must be one of this service line's departments";
  static readonly DEPARTMENT_INVALID_MESSAGE = "Service area must be one of the defined areas (or Unassigned)";

  /** The default line's rules (all seven departments, CVPSL's contracts leads). */
  static defaultRules(): LineRules {
    const scope = ServiceLine.defaultScope();
    return { contractsLeads: scope.contractsLeads, departments: scope.departments };
  }

  /** Rules of a service line scope. */
  static rulesOf(scope: { contractsLeads: readonly string[]; departments: DepartmentList }): LineRules {
    return { contractsLeads: scope.contractsLeads, departments: scope.departments };
  }

  /**
   * Contracts lead canonical spelling and department membership for the line. Adds errors in place and
   * returns the corrected data. `existing` grandfathers unchanged stored values.
   */
  private static applyLineRules(data: ProjectData, rules: LineRules, existing: ProjectInput | null, errors: FieldErrors): ProjectData {
    const out = { ...data };
    if (out.contractsLead !== null) {
      const lead = ContractsLead.resolve(out.contractsLead, rules.contractsLeads);
      const stored = existing?.contractsLead ?? null;
      if (lead) out.contractsLead = lead;
      else if (stored !== null && stored.trim().replace(/\s+/g, " ").toLowerCase() === out.contractsLead.trim().replace(/\s+/g, " ").toLowerCase()) out.contractsLead = stored;
      else (errors.contractsLead ??= []).push(ContractsLead.invalidMessage(out.contractsLead, rules.contractsLeads));
    }
    if (out.serviceArea !== null) {
      // A department id (or an old enum value, read as the department that replaced it). Unchanged stored values
      // are kept even when the department was archived since; a new choice must be an open department.
      const dept = ServiceAreaInfo.find(rules.departments, out.serviceArea);
      if (dept) out.serviceArea = dept.id;
      const stored = existing?.serviceArea ?? null;
      if (!dept && stored !== out.serviceArea) (errors.serviceArea ??= []).push(ProjectValidator.DEPARTMENT_INVALID_MESSAGE);
      else if (dept && !ServiceAreaInfo.isOpen(dept) && stored !== dept.id) (errors.serviceArea ??= []).push(ProjectValidator.DEPARTMENT_NOT_IN_LINE_MESSAGE);
    }
    return out;
  }

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

  /** Fields with a hard character cap (the edit form counter stops at the cap). */
  static readonly HARD_LIMITS = {
    note: AppConfig.NOTE_MAX_LENGTH,
    accomplishment: AppConfig.ACCOMPLISHMENT_MAX_LENGTH,
    description: AppConfig.DESCRIPTION_MAX_LENGTH,
    name: AppConfig.SHORT_TEXT_MAX_LENGTH,
    owner: AppConfig.SHORT_TEXT_MAX_LENGTH,
  } as const satisfies Partial<Record<keyof ProjectInput, number>>;

  /** Fields with a soft limit in the edit form: past it the counter warns, but saving is allowed. */
  static readonly SOFT_LIMITS = { nextMilestone: AppConfig.MILESTONE_MAX_LENGTH } as const satisfies Partial<Record<keyof ProjectInput, number>>;

  /** Backstop for a soft-limited field in the edit form (it is still text in a table cell). */
  static readonly SOFT_BACKSTOP = AppConfig.SHORT_TEXT_MAX_LENGTH;

  static readonly DEPARTMENT_REQUIRED_MESSAGE = "Department is required";

  private static readonly schema = ProjectValidator.buildSchema(ProjectValidator.MILESTONE_MAX);
  private static readonly formSchema = ProjectValidator.buildSchema(ProjectValidator.SOFT_BACKSTOP);

  /**
   * Validation for the drawer edit form (and New project): the same rules as validate(), except the
   * next milestone limit is soft (up to SOFT_BACKSTOP characters; softWarnings() reports past 40), a new
   * project needs a department, and unchanged stored values over a cap are accepted (see
   * FormValidationOptions.existing).
   */
  static validateForm(input: ProjectInput, options: FormValidationOptions): ValidationResult {
    const { checked, restore } = ProjectValidator.grandfather(input, options.existing, ProjectValidator.SOFT_BACKSTOP);
    const parsed = ProjectValidator.formSchema.safeParse(checked);
    const errors: FieldErrors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = (issue.path[0] as keyof FieldErrors | undefined) ?? "_form";
        (errors[key] ??= []).push(issue.message);
      }
    }
    if (!options.existing && (input.serviceArea === null || input.serviceArea === undefined || String(input.serviceArea).trim() === "")) {
      (errors.serviceArea ??= []).push(ProjectValidator.DEPARTMENT_REQUIRED_MESSAGE);
    }
    const data = parsed.success ? ProjectValidator.applyLineRules(parsed.data, options.rules ?? ProjectValidator.defaultRules(), options.existing, errors) : null;
    if (!data || Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, data: { ...data, ...restore } };
  }

  /**
   * Default rules for an update of a stored project (People autosave, CSV wording update): like parse(),
   * but a capped field left at its stored value is not length-checked, so an existing over-cap value
   * (for example a milestone over 40 saved from the edit form) never blocks an unrelated save.
   */
  static parseUpdate(input: ProjectInput, existing: ProjectInput, rules?: LineRules): ProjectData {
    const { checked, restore } = ProjectValidator.grandfather(input, existing, ProjectValidator.MILESTONE_MAX);
    return { ...ProjectValidator.parse(checked, rules, existing), ...restore };
  }

  /** Like validateForm() but throws ProjectValidationError. */
  static parseForm(input: ProjectInput, options: FormValidationOptions): ProjectData {
    const result = ProjectValidator.validateForm(input, options);
    if (!result.ok) throw new ProjectValidationError(result.errors);
    return result.data;
  }

  /** Non-blocking warnings for the edit form (soft limits exceeded), keyed like FieldErrors. */
  static softWarnings(input: Partial<ProjectInput>): FieldErrors {
    const out: FieldErrors = {};
    for (const [field, limit] of Object.entries(ProjectValidator.SOFT_LIMITS) as [keyof ProjectInput, number][]) {
      const v = input[field];
      if (typeof v === "string" && v.trim().length > limit) out[field] = [`Over ${limit} characters; it may be cut off in the report`];
    }
    return out;
  }

  /**
   * Swap capped fields whose value equals the stored value (and is over the cap) for a within-cap
   * stand-in before schema checks, and remember the original (trimmed) text to put back afterwards.
   */
  private static grandfather(
    input: ProjectInput,
    existing: ProjectInput | null,
    milestoneCap: number,
  ): { checked: ProjectInput; restore: Record<string, string> } {
    const checked: Record<string, unknown> = { ...input };
    const restore: Record<string, string> = {};
    if (!existing) return { checked: checked as unknown as ProjectInput, restore };
    const caps: Record<string, number> = { ...ProjectValidator.HARD_LIMITS, nextMilestone: milestoneCap };
    for (const [field, cap] of Object.entries(caps)) {
      const value = checked[field];
      const stored = (existing as unknown as Record<string, unknown>)[field];
      if (typeof value !== "string" || typeof stored !== "string") continue;
      const t = value.trim();
      if (t.length > cap && t === stored.trim()) {
        checked[field] = t.slice(0, cap);
        restore[field] = t;
      }
    }
    return { checked: checked as unknown as ProjectInput, restore };
  }

  /** Validate and normalize a full set of editable fields. */
  static validate(input: unknown, rules: LineRules = ProjectValidator.defaultRules(), existing: ProjectInput | null = null): ValidationResult {
    const parsed = ProjectValidator.schema.safeParse(input);
    const errors: FieldErrors = {};
    if (parsed.success) {
      const data = ProjectValidator.applyLineRules(parsed.data, rules, existing, errors);
      return Object.keys(errors).length ? { ok: false, errors } : { ok: true, data };
    }
    for (const issue of parsed.error.issues) {
      const key = (issue.path[0] as keyof FieldErrors | undefined) ?? "_form";
      (errors[key] ??= []).push(issue.message);
    }
    return { ok: false, errors };
  }

  /** Like validate() but throws ProjectValidationError. */
  static parse(input: unknown, rules?: LineRules, existing: ProjectInput | null = null): ProjectData {
    const result = ProjectValidator.validate(input, rules, existing);
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
      requesterNotApplicable: project.requesterNotApplicable,
      contractsLead: project.contractsLead,
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

  private static buildSchema(milestoneMax: number) {
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
        serviceArea: z.preprocess(
          (v) => (v === undefined || v === null || (typeof v === "string" && (v.trim() === "" || ServiceAreaInfo.isUnassignedText(v))) ? null : v),
          z.string({ error: ProjectValidator.DEPARTMENT_INVALID_MESSAGE }).transform((v) => v.trim()).nullable(),
        ),
        owner: ProjectValidator.optionalText({ label: "Owner", length: ProjectValidator.NAME_MAX }),
        physicianChampion: ProjectValidator.optionalText(),
        // Checked against the service line's list after parsing (applyLineRules).
        contractsLead: z
          .preprocess((v) => (v === undefined ? null : v), z.string().nullable())
          .transform((v) => (v === null || v.trim() === "" ? null : v.trim().replace(/\s+/g, " "))),
        physicianChampionEmail: z.preprocess(
          (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v ?? null),
          z.email("Requester email is not a valid email").nullable(),
        ),
        requesterNotApplicable: z.boolean().default(false),
        status: z.enum(ProjectStatus, { error: "Status must be one of the defined statuses" }),
        nextMilestone: ProjectValidator.optionalText({
          label: "Next milestone",
          length: milestoneMax,
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
      })
      // Requester: a name and Not applicable never coexist. On the merged record NA wins (update() has
      // already cleared it when the patch set a name); "Not applicable" text in the name means NA.
      .transform((p) => {
        const na = p.requesterNotApplicable || Requester.isNotApplicableText(p.physicianChampion);
        return { ...p, physicianChampion: na ? null : p.physicianChampion, requesterNotApplicable: na };
      });
  }
}
