import { CsvError, parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { Requester } from "@/lib/domain/Requester";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ProjectRecord } from "@/lib/domain/types";
import { ProjectValidator, type FieldErrors, type ProjectInput } from "@/lib/validation/ProjectValidator";

/** A CSV column in the project import/export template. */
export type CsvColumn =
  | "id"
  | "name"
  | "description"
  | "infor_request_number"
  | "service_area"
  | "owner"
  | "requester"
  | "status"
  | "next_milestone"
  | "due_date"
  | "percent_complete"
  | "note"
  | "accomplishment"
  | "completed_on"
  | "include_in_report";

/** Editable ProjectInput fields that have a template column. */
export type TemplateField = Exclude<keyof ProjectInput, "targetCompletion">;

export interface CsvRow {
  /** 1-based line number in the file where this record ends (header is line 1). */
  line: number;
  /** Raw cell text keyed by normalized column name. Missing columns are absent. */
  cells: Partial<Record<CsvColumn, string>>;
}

export interface ParsedCsv {
  /** Problems that make the whole file unusable (bad CSV, missing required columns, too many rows). */
  fileErrors: string[];
  /** Non-fatal file notes (e.g. unknown columns that will be ignored). */
  fileWarnings: string[];
  columns: CsvColumn[];
  rows: CsvRow[];
}

export interface RowConversion {
  /** Partial input: only fields whose column is present in the file. */
  input: Partial<ProjectInput>;
  /** Conversion errors keyed by CSV column (bad enum, bad date format, ...). */
  errors: Partial<Record<CsvColumn, string[]>>;
}

/**
 * The project CSV format: column list, template, parsing, cell normalization, and export rows.
 * Enum cells tolerate case and whitespace ("on track", "OnTrack", " cardio neuro ").
 * Dates accept YYYY-MM-DD or M/D/YYYY.
 */
export class ProjectCsv {
  /** Template/import columns, in template order. */
  static readonly TEMPLATE_COLUMNS: readonly CsvColumn[] = [
    "name",
    "description",
    "infor_request_number",
    "service_area",
    "owner",
    "requester",
    "status",
    "next_milestone",
    "due_date",
    "percent_complete",
    "note",
    "accomplishment",
    "completed_on",
    "include_in_report",
  ];

  /** Export columns: a leading id, then the template columns. */
  static readonly EXPORT_COLUMNS: readonly CsvColumn[] = ["id", ...ProjectCsv.TEMPLATE_COLUMNS];

  /** Columns a new-project import file must have. */
  static readonly REQUIRED_FOR_CREATE: readonly CsvColumn[] = ["name", "service_area", "status"];

  /** Columns a wording-update file must have (description is optional; absent means unchanged). */
  static readonly REQUIRED_FOR_WORDING: readonly CsvColumn[] = ["id", "note", "next_milestone"];

  /** CSV column to ProjectInput field. */
  static readonly FIELD_BY_COLUMN: Readonly<Record<Exclude<CsvColumn, "id">, TemplateField>> = {
    name: "name",
    description: "description",
    infor_request_number: "inforRequestNumber",
    service_area: "serviceArea",
    owner: "owner",
    requester: "physicianChampion",
    status: "status",
    next_milestone: "nextMilestone",
    due_date: "dueDate",
    percent_complete: "percentComplete",
    note: "note",
    accomplishment: "accomplishment",
    completed_on: "completedOn",
    include_in_report: "includeInReport",
  };

  /** Rows whose name starts with this prefix are the template's fake examples and are skipped. */
  static readonly EXAMPLE_PREFIX = "Example:";

  static readonly TEMPLATE_EXAMPLES: readonly Record<Exclude<CsvColumn, "id">, string>[] = [
    {
      name: "Example: Sample cath lab project (delete this row)",
      description: "Fake example: replace the cath lab 3 imaging system. Optional, up to 200 characters.",
      infor_request_number: "4656",
      service_area: "Cath",
      owner: "Example Owner A",
      requester: "Dr. Example A",
      status: "On track",
      next_milestone: "Vendor kickoff call",
      due_date: "2026-10-15",
      percent_complete: "25",
      note: "Fake example row. Delete it before importing. Notes can be up to 200 characters.",
      accomplishment: "",
      completed_on: "",
      include_in_report: "yes",
    },
    {
      name: "Example: Sample EP pathway (delete this row)",
      description: "",
      infor_request_number: "",
      service_area: "EP",
      owner: "Example Owner B",
      requester: "Not applicable",
      status: "Not started",
      next_milestone: "Charter approval",
      due_date: "11/2/2026",
      percent_complete: "",
      note: "Fake example row showing an M/D/YYYY date and blank optional fields.",
      accomplishment: "",
      completed_on: "",
      include_in_report: "no",
    },
  ];

  /**
   * Columns other tools add that the app recognizes but does not store (yet). They are ignored with a
   * specific warning instead of the generic "unknown column" one.
   */
  static readonly RECOGNIZED_IGNORED_COLUMNS: Readonly<Record<string, string>> = {
    older_update:
      'Column "older_update" is not imported: the app has no place for older updates yet, so its values are ignored.',
    owner_suggested: 'Column "owner_suggested" is a reference column and is not imported. Owners are set in the app.',
    department_basis: 'Column "department_basis" is a reference column and is not imported.',
    physician_champion_email: 'Column "physician_champion_email" is not imported: requester emails are no longer used.',
  };

  /** Other header names accepted for a column (normalized). */
  static readonly COLUMN_ALIASES: Readonly<Record<string, CsvColumn>> = {
    department: "service_area",
    physician_champion: "requester",
    champion: "requester",
  };

  private static readonly KNOWN_COLUMNS: ReadonlySet<string> = new Set(ProjectCsv.EXPORT_COLUMNS);
  private static readonly TRUE_WORDS: ReadonlySet<string> = new Set(["yes", "y", "true", "t", "1"]);
  private static readonly FALSE_WORDS: ReadonlySet<string> = new Set(["no", "n", "false", "f", "0"]);
  private static readonly US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

  /** The downloadable template (header plus the two fake example rows). */
  static templateCsv(): string {
    return ProjectCsv.stringify(
      ProjectCsv.TEMPLATE_COLUMNS,
      ProjectCsv.TEMPLATE_EXAMPLES.map((ex) => ProjectCsv.TEMPLATE_COLUMNS.map((c) => ex[c as keyof typeof ex])),
    );
  }

  /** Export rows (id + template columns) for the given projects. */
  static exportCsv(projects: readonly ProjectRecord[]): string {
    return ProjectCsv.stringify(
      ProjectCsv.EXPORT_COLUMNS,
      projects.map((p) => {
        const cells = ProjectCsv.toCells(p);
        return ProjectCsv.EXPORT_COLUMNS.map((c) => cells[c]);
      }),
    );
  }

  /** One project as CSV cell text, in the same formats the importer reads. */
  static toCells(p: ProjectRecord): Record<CsvColumn, string> {
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      infor_request_number: p.inforRequestNumber === null ? "" : String(p.inforRequestNumber),
      service_area: p.serviceArea ? ServiceAreaInfo.label(p.serviceArea) : "",
      owner: p.owner ?? "",
      requester: Requester.cellText(p.physicianChampion, p.requesterNotApplicable),
      status: ProjectStatusInfo.label(p.status),
      next_milestone: p.nextMilestone ?? "",
      due_date: DateOnly.fromDbDate(p.dueDate) ?? "",
      percent_complete: p.percentComplete === null ? "" : String(p.percentComplete),
      note: p.note ?? "",
      accomplishment: p.accomplishment ?? "",
      completed_on: DateOnly.fromDbDate(p.completedOn) ?? "",
      include_in_report: p.includeInReport ? "yes" : "no",
    };
  }

  /** Header names are matched case-insensitively; spaces and hyphens count as underscores. */
  static normalizeHeader(raw: string): string {
    return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  }

  static parse(text: string, required: readonly CsvColumn[]): ParsedCsv {
    const result: ParsedCsv = { fileErrors: [], fileWarnings: [], columns: [], rows: [] };
    let records: { record: string[]; info: { lines: number } }[];
    try {
      records = parse(text, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        info: true,
      }) as unknown as typeof records;
    } catch (e) {
      const detail = e instanceof CsvError ? e.message : String(e);
      result.fileErrors.push(`The file could not be read as CSV: ${detail}`);
      return result;
    }
    if (records.length === 0) {
      result.fileErrors.push("The file is empty. Start from the template.");
      return result;
    }

    const header = records[0].record.map(ProjectCsv.normalizeHeader).map((h) => ProjectCsv.COLUMN_ALIASES[h] ?? h);
    const indexByColumn = new Map<CsvColumn, number>();
    header.forEach((h, i) => {
      if (!h) return;
      const ignored = ProjectCsv.RECOGNIZED_IGNORED_COLUMNS[h];
      if (ignored) {
        result.fileWarnings.push(ignored);
        return;
      }
      if (!ProjectCsv.KNOWN_COLUMNS.has(h)) {
        result.fileWarnings.push(`Unknown column "${records[0].record[i].trim()}" will be ignored.`);
        return;
      }
      const col = h as CsvColumn;
      if (indexByColumn.has(col)) {
        result.fileErrors.push(`Column "${col}" appears more than once.`);
        return;
      }
      indexByColumn.set(col, i);
    });
    result.columns = [...indexByColumn.keys()];
    const missing = required.filter((c) => !indexByColumn.has(c));
    if (missing.length) result.fileErrors.push(`Missing required column(s): ${missing.join(", ")}.`);

    for (const { record, info } of records.slice(1)) {
      if (record.every((cell) => cell.trim() === "")) continue;
      const cells: CsvRow["cells"] = {};
      for (const [col, i] of indexByColumn) cells[col] = record[i] ?? "";
      result.rows.push({ line: info.lines, cells });
    }
    if (result.rows.length === 0 && result.fileErrors.length === 0) {
      result.fileErrors.push("The file has a header but no project rows.");
    }
    if (result.rows.length > AppConfig.IMPORT_MAX_ROWS) {
      result.fileErrors.push(
        `The file has ${result.rows.length} rows; the limit is ${AppConfig.IMPORT_MAX_ROWS} per import. Split it into smaller files.`,
      );
    }
    return result;
  }

  /** Convert the present cells of a row to ProjectInput values. Validation proper is ProjectValidator's job. */
  static toInput(row: CsvRow, opts: { blankStatus?: ProjectStatus } = {}): RowConversion {
    const input: Partial<ProjectInput> = {};
    const errors: RowConversion["errors"] = {};
    const fail = (col: CsvColumn, msg: string) => (errors[col] ??= []).push(msg);

    for (const [col, field] of Object.entries(ProjectCsv.FIELD_BY_COLUMN) as [Exclude<CsvColumn, "id">, TemplateField][]) {
      const raw = row.cells[col];
      if (raw === undefined) continue;
      const value = raw.trim();
      switch (col) {
        case "service_area": {
          // Blank or "Unassigned" (any case) = no department (grouped as Unassigned).
          if (value === "" || ServiceAreaInfo.isUnassignedText(value)) {
            input.serviceArea = null;
            break;
          }
          const area = ProjectCsv.resolveServiceArea(value);
          if (area) input.serviceArea = area;
          else {
            fail(
              col,
              `"${value}" is not a service area. Use one of: ${ServiceAreaInfo.all().join(", ")}, or Unassigned (or leave blank)`,
            );
            input.serviceArea = value;
          }
          break;
        }
        case "requester": {
          // Name; "Not applicable" / "N/A" / "NA" (any case) = Not applicable; blank = not yet addressed.
          if (Requester.isNotApplicableText(value)) {
            input.physicianChampion = null;
            input.requesterNotApplicable = true;
          } else {
            input.physicianChampion = value === "" ? null : value;
            input.requesterNotApplicable = false;
          }
          break;
        }
        case "status": {
          if (value === "" && opts.blankStatus) {
            // New projects: a blank status means On track.
            input.status = opts.blankStatus;
            break;
          }
          const status = ProjectCsv.resolveStatus(value);
          if (status) input.status = status;
          else {
            fail(col, `"${value}" is not a status. Use one of: ${ProjectStatusInfo.all().map(ProjectStatusInfo.label).join(", ")}`);
            input.status = value;
          }
          break;
        }
        case "due_date": {
          const iso = ProjectCsv.resolveDate(value);
          if (iso === undefined) {
            fail(col, `"${value}" is not a valid date. Use YYYY-MM-DD or M/D/YYYY`);
            input.dueDate = value;
          } else input.dueDate = iso;
          break;
        }
        case "completed_on": {
          const iso = ProjectCsv.resolveDate(value);
          if (iso === undefined) {
            fail(col, `"${value}" is not a valid date. Use YYYY-MM-DD or M/D/YYYY`);
            input.completedOn = value;
          } else input.completedOn = iso;
          break;
        }
        case "percent_complete": {
          if (value === "") input.percentComplete = null;
          else {
            const n = Number(value.replace(/%$/, "").trim());
            if (Number.isFinite(n)) input.percentComplete = n;
            else {
              fail(col, `"${value}" is not a number`);
              input.percentComplete = null;
            }
          }
          break;
        }
        case "infor_request_number": {
          const n = ProjectValidator.parseInforNumber(value);
          if (n === undefined || (n !== null && (n < ProjectValidator.INFOR_MIN || n > ProjectValidator.INFOR_MAX))) {
            fail(
              col,
              `"${value}" is not a valid Infor request number. Use a whole number from ${ProjectValidator.INFOR_MIN} to ${ProjectValidator.INFOR_MAX} (blank = none)`,
            );
            input.inforRequestNumber = null;
          } else input.inforRequestNumber = n;
          break;
        }
        case "include_in_report": {
          const b = ProjectCsv.resolveBoolean(value);
          if (b === undefined) {
            fail(col, `"${value}" is not yes or no`);
            input.includeInReport = true;
          } else input.includeInReport = b;
          break;
        }
        default:
          (input as Record<string, unknown>)[field] = raw;
      }
    }
    return { input, errors };
  }

  /** Map ProjectValidator field errors back to CSV column names. */
  static columnErrors(fieldErrors: FieldErrors): Partial<Record<CsvColumn | "_row", string[]>> {
    const out: Partial<Record<CsvColumn | "_row", string[]>> = {};
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const col = ProjectCsv.columnFor(field) ?? "_row";
      (out[col] ??= []).push(...(messages ?? []));
    }
    return out;
  }

  static columnFor(field: string): CsvColumn | undefined {
    const hit = Object.entries(ProjectCsv.FIELD_BY_COLUMN).find(([, f]) => f === field);
    return hit?.[0] as CsvColumn | undefined;
  }

  static isExampleRow(row: CsvRow): boolean {
    return (row.cells.name ?? "").trim().toLowerCase().startsWith(ProjectCsv.EXAMPLE_PREFIX.toLowerCase());
  }

  /** Case- and whitespace-insensitive match against enum keys and display labels. */
  static resolveServiceArea(value: string): ServiceArea | null {
    const key = ProjectCsv.enumKey(value);
    const direct = (Object.values(ServiceArea) as ServiceArea[]).find(
      (a) => ProjectCsv.enumKey(a) === key || ProjectCsv.enumKey(ServiceAreaInfo.label(a)) === key,
    );
    if (direct) return direct;
    const alias = Object.entries(ServiceAreaInfo.ALIASES).find(([name]) => ProjectCsv.enumKey(name) === key);
    return alias ? alias[1] : null;
  }

  static resolveStatus(value: string): ProjectStatus | null {
    const key = ProjectCsv.enumKey(value);
    return (
      (Object.values(ProjectStatus) as ProjectStatus[]).find(
        (s) => ProjectCsv.enumKey(s) === key || ProjectCsv.enumKey(ProjectStatusInfo.label(s)) === key,
      ) ?? null
    );
  }

  /**
   * "" -> null; a real calendar date as YYYY-MM-DD or M/D/YYYY -> "YYYY-MM-DD";
   * anything else (wrong format, or a date like 2/30/2026) -> undefined.
   */
  static resolveDate(value: string): string | null | undefined {
    const v = value.trim();
    if (v === "") return null;
    const m = ProjectCsv.US_DATE_RE.exec(v);
    const iso = m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : v;
    return DateOnly.isIso(iso) ? iso : undefined;
  }

  /** Blank means yes (the model default). */
  static resolveBoolean(value: string): boolean | undefined {
    const v = value.trim().toLowerCase();
    if (v === "") return true;
    if (ProjectCsv.TRUE_WORDS.has(v)) return true;
    if (ProjectCsv.FALSE_WORDS.has(v)) return false;
    return undefined;
  }

  private static enumKey(value: string): string {
    return value.toLowerCase().replace(/[\s_-]+/g, "");
  }

  private static stringify(columns: readonly string[], rows: string[][]): string {
    return stringify([columns as string[], ...rows], { record_delimiter: "\n" });
  }
}
