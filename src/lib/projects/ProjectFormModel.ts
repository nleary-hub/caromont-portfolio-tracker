import type { ProjectStatus } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { FieldErrors, ProjectInput } from "@/lib/validation/ProjectValidator";
import { StartDate } from "@/lib/projects/StartDate";

/**
 * The drawer edit form's values, all as strings (what the inputs hold). People fields are not here:
 * they save on pick through the People editor.
 */
export interface ProjectFormValues {
  name: string;
  /** DepartmentKey value, or "" for none. */
  serviceArea: string;
  status: string;
  /** Digits only, without the "REQ-" prefix; "" for none. */
  inforRequestNumber: string;
  nextMilestone: string;
  /** YYYY-MM-DD or "". */
  dueDate: string;
  /** "0" to "100" or "". */
  percentComplete: string;
  /** Latest update. */
  note: string;
  accomplishment: string;
  description: string;
  /** YYYY-MM-DD or "". Shown only while the status is Complete. */
  completedOn: string;
  /** YYYY-MM-DD (America/New_York day). New project: pre-filled with today. */
  startDate: string;
}

export type FormField = keyof ProjectFormValues;

/** The stored fields the form reads (a DB project or an admin form snapshot). */
export interface ProjectFormSource {
  name: string;
  serviceArea: string | null;
  status: string;
  inforRequestNumber: number | null;
  nextMilestone: string | null;
  dueDate: Date | string | null;
  percentComplete: number | null;
  note: string | null;
  accomplishment: string | null;
  description: string | null;
  completedOn: Date | string | null;
  /** Absent on sources read without it (the form then starts blank). */
  startDate?: Date | string | null;
}

export interface FieldCounter {
  count: number;
  limit: number;
  /** "hard": the input stops at the limit. "soft": past the limit is a warning only. */
  kind: "hard" | "soft";
  /** Shown in the overdue color: at the limit (hard) or past it (soft). */
  alert: boolean;
}

/**
 * Pure rules for the admin drawer edit form (client side). The server is the authority: the same
 * values go through ProjectValidator.validateForm in ProjectService.saveForm/createFromForm, and its
 * field errors come back to the form. These checks only give instant feedback.
 */
export class ProjectFormModel {
  static readonly DEFAULT_STATUS: ProjectStatus = "NotStarted";

  /** Hard caps: the counter turns the overdue color at the limit and the input takes no more. */
  static readonly HARD_LIMITS: Readonly<Partial<Record<FormField, number>>> = {
    note: AppConfig.NOTE_MAX_LENGTH,
    accomplishment: AppConfig.ACCOMPLISHMENT_MAX_LENGTH,
    description: AppConfig.DESCRIPTION_MAX_LENGTH,
  };

  /** Soft limits: past the limit the counter warns, saving is still allowed. */
  static readonly SOFT_LIMITS: Readonly<Partial<Record<FormField, number>>> = {
    nextMilestone: AppConfig.MILESTONE_SOFT_LENGTH,
  };

  /** Longest text a soft-limited input or the name accepts. */
  static readonly TEXT_BACKSTOP = AppConfig.SHORT_TEXT_MAX_LENGTH;

  static readonly INFOR_DIGITS = 5;
  static readonly ACCOMPLISHMENT_HINT = "Add an accomplishment for the report";
  static readonly DISCARD_PROMPT = "Discard changes?";

  static readonly LABELS: Readonly<Record<FormField, string>> = {
    name: "Name",
    serviceArea: "Department",
    status: "Status",
    inforRequestNumber: "Infor number",
    nextMilestone: "Next milestone",
    dueDate: "Due date",
    percentComplete: "% complete",
    note: "Latest update",
    accomplishment: "Accomplishment",
    description: "Description",
    completedOn: "Completion date",
    startDate: StartDate.LABEL,
  };

  /** Fields in on-screen order (first error scrolls into view). */
  static readonly ORDER: readonly FormField[] = [
    "name",
    "serviceArea",
    "status",
    "startDate",
    "completedOn",
    "inforRequestNumber",
    "nextMilestone",
    "dueDate",
    "percentComplete",
    "note",
    "accomplishment",
    "description",
  ];

  /** A new project's values; `today` (YYYY-MM-DD, America/New_York) pre-fills Start date. */
  static empty(today: string = ""): ProjectFormValues {
    return {
      name: "",
      serviceArea: "",
      status: ProjectFormModel.DEFAULT_STATUS,
      inforRequestNumber: "",
      nextMilestone: "",
      dueDate: "",
      percentComplete: "",
      note: "",
      accomplishment: "",
      description: "",
      completedOn: "",
      startDate: today,
    };
  }

  static fromSource(p: ProjectFormSource): ProjectFormValues {
    const date = (d: Date | string | null) => (d instanceof Date ? DateOnly.fromDbDate(d) ?? "" : d ?? "");
    return {
      name: p.name,
      serviceArea: p.serviceArea ?? "",
      status: p.status,
      inforRequestNumber: p.inforRequestNumber === null ? "" : String(p.inforRequestNumber),
      nextMilestone: p.nextMilestone ?? "",
      dueDate: date(p.dueDate),
      percentComplete: p.percentComplete === null ? "" : String(p.percentComplete),
      note: p.note ?? "",
      accomplishment: p.accomplishment ?? "",
      description: p.description ?? "",
      completedOn: date(p.completedOn),
      startDate: date(p.startDate ?? null),
    };
  }

  /** Server side: form strings to validator input (blank = null; the validator trims and checks). */
  static toInput(v: Partial<ProjectFormValues>): Partial<ProjectInput> {
    const out: Partial<ProjectInput> = {};
    const text = (s: string | undefined) => (s === undefined ? undefined : String(s));
    if (v.name !== undefined) out.name = String(v.name);
    if (v.serviceArea !== undefined) out.serviceArea = text(v.serviceArea) || null;
    if (v.status !== undefined) out.status = String(v.status);
    if (v.inforRequestNumber !== undefined) out.inforRequestNumber = text(v.inforRequestNumber)?.trim() || null;
    if (v.nextMilestone !== undefined) out.nextMilestone = text(v.nextMilestone);
    if (v.dueDate !== undefined) out.dueDate = text(v.dueDate) || null;
    if (v.percentComplete !== undefined) {
      const t = String(v.percentComplete).trim();
      out.percentComplete = t === "" ? null : (Number(t) as number);
    }
    if (v.note !== undefined) out.note = text(v.note);
    if (v.accomplishment !== undefined) out.accomplishment = text(v.accomplishment);
    if (v.description !== undefined) out.description = text(v.description);
    if (v.completedOn !== undefined) out.completedOn = text(v.completedOn) || null;
    // Blank stays "" so the server reports "Start date is required." (it is never the import default from a form).
    if (v.startDate !== undefined) out.startDate = String(v.startDate).trim();
    return out;
  }

  /** Only the fields that differ from the original (what a save sends). */
  static changes(values: ProjectFormValues, original: ProjectFormValues): Partial<ProjectFormValues> {
    const out: Partial<ProjectFormValues> = {};
    for (const f of Object.keys(values) as FormField[]) if (values[f] !== original[f]) out[f] = values[f];
    return out;
  }

  static isDirty(values: ProjectFormValues, original: ProjectFormValues): boolean {
    return Object.keys(ProjectFormModel.changes(values, original)).length > 0;
  }

  /** "n/limit" counter state for a limited field, or null for a field without a counter. */
  static counter(field: FormField, value: string): FieldCounter | null {
    const hard = ProjectFormModel.HARD_LIMITS[field];
    if (hard !== undefined) return { count: value.length, limit: hard, kind: "hard", alert: value.length >= hard };
    const soft = ProjectFormModel.SOFT_LIMITS[field];
    if (soft !== undefined) return { count: value.length, limit: soft, kind: "soft", alert: value.trim().length > soft };
    return null;
  }

  /** Long-text fields (2,000 characters): auto-growing textarea and the "1,240 / 2,000" counter. */
  static readonly LONG_TEXT: ReadonlySet<FormField> = new Set<FormField>(["note"]);

  static isLongText(field: FormField): boolean {
    return ProjectFormModel.LONG_TEXT.has(field);
  }

  /** The input's maxLength (hard cap, or the backstop for soft and plain text fields). */
  static maxLength(field: FormField): number {
    return ProjectFormModel.HARD_LIMITS[field] ?? ProjectFormModel.TEXT_BACKSTOP;
  }

  /** Keep only digits, at most INFOR_DIGITS of them (the input shows a fixed "REQ-" prefix). */
  static inforDigits(raw: string): string {
    return raw.replace(/\D+/g, "").slice(0, ProjectFormModel.INFOR_DIGITS);
  }

  /**
   * Status change (task 5). Leaving Complete empties the completion date: the server clears every completion date when
   * the status is not Complete, so the form never keeps (or later brings back) a date the server would drop. Coming back
   * to Complete restores, in order: `opts.resume` (the date on screen when the status left Complete in this session,
   * even "" after "Use automatic date"), then the stored date when the project was stored as Complete, else today
   * (America/New_York) as a visible prefill. A stored date on a project that is not Complete is stale and never reused.
   */
  static withStatus(values: ProjectFormValues, status: string, original: ProjectFormValues, today: string = DateOnly.today(), opts: { resume?: string } = {}): ProjectFormValues {
    if (status !== "Complete") return { ...values, status, completedOn: "" };
    if (values.status === "Complete") return { ...values, status };
    if (opts.resume !== undefined) return { ...values, status, completedOn: opts.resume };
    if (original.status === "Complete") return { ...values, status, completedOn: original.completedOn };
    return { ...values, status, completedOn: today };
  }

  static showsCompletedOn(values: ProjectFormValues): boolean {
    return values.status === "Complete";
  }

  /** Non-blocking hint under Accomplishment. */
  static accomplishmentHint(values: ProjectFormValues): string | null {
    return values.status === "Complete" && values.accomplishment.trim() === "" ? ProjectFormModel.ACCOMPLISHMENT_HINT : null;
  }

  /**
   * Instant client checks (the server repeats all of them through ProjectValidator). A stored value
   * already over a hard cap is flagged only once that field is edited.
   */
  static errors(
    values: ProjectFormValues,
    original: ProjectFormValues,
    isNew: boolean,
    departments: DepartmentList = ServiceAreaInfo.LEGACY,
    start: { today: string; isDefault?: boolean } = { today: DateOnly.today() },
  ): FieldErrors {
    const e: Record<string, string[]> = {};
    const add = (f: FormField, msg: string) => (e[f] ??= []).push(msg);
    if (values.name.trim() === "") add("name", "Name is required");
    if (isNew && values.serviceArea === "") add("serviceArea", "Department is required");
    // An open department of the line, or the project's own department even if it has since been archived.
    if (values.serviceArea !== "" && values.serviceArea !== original.serviceArea && !ServiceAreaInfo.isValid(values.serviceArea, departments)) add("serviceArea", "Pick a department");
    if (values.inforRequestNumber !== "" && !/^[0-9]{1,5}$/.test(values.inforRequestNumber)) add("inforRequestNumber", "Enter up to 5 digits");
    else if (values.inforRequestNumber !== "" && Number(values.inforRequestNumber) < AppConfig.INFOR_REQUEST_NUMBER_MIN) {
      add("inforRequestNumber", `Infor number must be from ${AppConfig.INFOR_REQUEST_NUMBER_MIN} to ${AppConfig.INFOR_REQUEST_NUMBER_MAX}`);
    }
    const status = values.status as ProjectStatus;
    if (ProjectStatusInfo.isValid(status) && !ProjectStatusInfo.milestoneOptional(status) && values.nextMilestone.trim() === "") {
      add("nextMilestone", "Next milestone is required for this status");
    }
    const pct = values.percentComplete.trim();
    if (pct !== "" && !(/^[0-9]{1,3}$/.test(pct) && Number(pct) <= 100)) add("percentComplete", "Enter a whole number from 0 to 100");
    for (const [field, limit] of Object.entries(ProjectFormModel.HARD_LIMITS) as [FormField, number][]) {
      const edited = isNew || values[field] !== original[field];
      if (edited && values[field].trim().length > limit) add(field, `${ProjectFormModel.LABELS[field]} must be at most ${limit} characters`);
    }
    for (const m of ProjectFormModel.startDateErrors(values, original, isNew, start)) add("startDate", m);
    return e as FieldErrors;
  }

  /**
   * Start date checks (same rule as ProjectService.startDateErrors): an edited start date, or a stored real one when
   * the status or completed date changes. A stored import default that is not edited is never checked against the
   * completed date, so an old Complete project stays editable.
   */
  static startDateErrors(values: ProjectFormValues, original: ProjectFormValues, isNew: boolean, start: { today: string; isDefault?: boolean }): string[] {
    const edited = isNew || values.startDate !== original.startDate;
    const closeChanged = values.status !== original.status || values.completedOn !== original.completedOn;
    if (!edited && (!closeChanged || start.isDefault || original.startDate === "")) return [];
    return StartDate.errors(values.startDate, { status: values.status, completedOn: values.completedOn, today: start.today });
  }

  /** The "Default" tag: the stored start date is still the import default and has not been changed in this edit. */
  static showsStartDateDefault(values: ProjectFormValues, original: ProjectFormValues, isDefault: boolean | undefined): boolean {
    return Boolean(isDefault) && original.startDate !== "" && values.startDate === original.startDate;
  }

  static hasErrors(errors: FieldErrors): boolean {
    return Object.values(errors).some((v) => (v?.length ?? 0) > 0);
  }

  /** First field with an error, in on-screen order. */
  static firstErrorField(errors: FieldErrors): FormField | null {
    return ProjectFormModel.ORDER.find((f) => (errors[f]?.length ?? 0) > 0) ?? null;
  }

  /** A stored value over a hard cap that has not been edited: counter red, no error yet. */
  static isGrandfathered(field: FormField, values: ProjectFormValues, original: ProjectFormValues): boolean {
    const limit = ProjectFormModel.HARD_LIMITS[field];
    return limit !== undefined && values[field] === original[field] && values[field].trim().length > limit;
  }
}
