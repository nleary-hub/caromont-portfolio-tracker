import type { PrismaClient } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { ProjectRecord } from "@/lib/domain/types";
import { ProjectService, type Actor, type Tx } from "@/lib/services/ProjectService";
import { ProjectValidator, type ProjectInput } from "@/lib/validation/ProjectValidator";
import { ProjectCsv, type CsvColumn, type CsvRow, type ParsedCsv } from "./ProjectCsv";

export type RowErrors = Partial<Record<CsvColumn | "_row", string[]>>;

export interface CreateRowResult {
  line: number;
  /** ready = will be created; skipped = duplicate or template example (warning); error = blocks the import. */
  status: "ready" | "skipped" | "error";
  cells: CsvRow["cells"];
  errors: RowErrors;
  warnings: string[];
  /** Normalized input for ready rows. */
  input: ProjectInput | null;
}

export interface CreatePreview {
  mode: "create";
  fileErrors: string[];
  fileWarnings: string[];
  columns: CsvColumn[];
  rows: CreateRowResult[];
  counts: { rows: number; ready: number; skipped: number; errors: number };
  /** True only when there are no file or row errors and at least one row to create. */
  canCommit: boolean;
}

export interface WordingChange {
  column: "description" | "note" | "next_milestone" | "accomplishment";
  old: string | null;
  new: string | null;
}

export interface WordingRowResult {
  line: number;
  id: string;
  /** Project name from the database (or the file when the id is unknown). */
  name: string;
  /** change = has description/note/next_milestone/accomplishment edits; unchanged = nothing to write; error = blocks the update. */
  status: "change" | "unchanged" | "error";
  changes: WordingChange[];
  errors: RowErrors;
  cells: CsvRow["cells"];
}

export interface WordingPreview {
  mode: "wording";
  fileErrors: string[];
  fileWarnings: string[];
  rows: WordingRowResult[];
  counts: { rows: number; changed: number; unchanged: number; errors: number };
  canCommit: boolean;
}

export type ImportPreview = CreatePreview | WordingPreview;

export class ImportBlockedError extends Error {
  constructor(readonly preview: ImportPreview) {
    super(
      preview.fileErrors.length
        ? `Import blocked: ${preview.fileErrors.join(" ")}`
        : preview.rows.some((r) => r.status === "error")
          ? `Import blocked: ${preview.rows.filter((r) => r.status === "error").length} row(s) have errors`
          : "Import blocked: nothing to import",
    );
    this.name = "ImportBlockedError";
  }
}

type Reader = Pick<PrismaClient, "project"> | Tx;

/**
 * CSV import of projects. Two modes:
 *  - create: new projects only. Duplicates by (name, service area) against non-archived projects are
 *    skipped with a warning and never overwritten.
 *  - wording: rows matched by id; only description, note, next_milestone and accomplishment may change. Any other column that differs
 *    from the database rejects the row.
 * preview*() is a dry run (no writes). commit*() re-runs the preview inside one transaction and writes
 * nothing unless every row is clean (all-or-nothing). All writes go through ProjectService, so every
 * project gets history rows (actor = the importing admin, comment = the source tag).
 */
export class ImportService {
  static readonly SOURCE_CREATE = "csv_import";
  static readonly SOURCE_WORDING = "csv_wording_update";
  /** The only columns a wording update may change. */
  static readonly WORDING_COLUMNS: readonly WordingChange["column"][] = ["description", "note", "next_milestone", "accomplishment"];
  private static readonly WORDING_FIELD: Readonly<Record<WordingChange["column"], "description" | "note" | "nextMilestone" | "accomplishment">> = {
    description: "description",
    accomplishment: "accomplishment",
    note: "note",
    next_milestone: "nextMilestone",
  };
  private static readonly LOCKED_MESSAGE = "A wording update may only change description, note, next_milestone and accomplishment.";

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly TX_OPTIONS = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 } as const;

  // ---------------------------------------------------------------- create

  static async previewCreate(csv: string, db: Reader = Db.client): Promise<CreatePreview> {
    return ImportService.buildCreatePreview(ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_CREATE), db);
  }

  static async commitCreate(
    csv: string,
    adminEmail: string,
    db: PrismaClient = Db.client,
  ): Promise<{ created: number; skipped: number; preview: CreatePreview }> {
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_CREATE);
    const actor: Actor = { changedBy: adminEmail, comment: ImportService.SOURCE_CREATE };
    return db.$transaction(async (tx) => {
      const preview = await ImportService.buildCreatePreview(parsed, tx);
      if (!preview.canCommit) throw new ImportBlockedError(preview);
      for (const row of preview.rows) {
        if (row.status === "ready" && row.input) await ProjectService.createInTx(tx, row.input, actor);
      }
      return { created: preview.counts.ready, skipped: preview.counts.skipped, preview };
    }, ImportService.TX_OPTIONS);
  }

  private static async buildCreatePreview(parsed: ParsedCsv, db: Reader): Promise<CreatePreview> {
    const rows: CreateRowResult[] = [];
    if (parsed.fileErrors.length === 0) {
      const existing = await db.project.findMany({
        where: { archivedAt: null },
        select: { name: true, serviceArea: true },
      });
      const existingKeys = new Set(existing.map((p) => ImportService.duplicateKey(p.name, p.serviceArea)));
      const seenInFile = new Map<string, number>();

      for (const row of parsed.rows) {
        const result: CreateRowResult = { line: row.line, status: "ready", cells: row.cells, errors: {}, warnings: [], input: null };
        rows.push(result);
        if (ProjectCsv.isExampleRow(row)) {
          result.status = "skipped";
          result.warnings.push("Template example row skipped. Delete it from your file.");
          continue;
        }
        const { input, errors } = ImportService.validateRow(row);
        result.errors = errors;
        if (Object.keys(errors).length) {
          result.status = "error";
          continue;
        }
        result.input = input as ProjectInput;
        const key = ImportService.duplicateKey(String(input.name), String(input.serviceArea));
        if (existingKeys.has(key)) {
          result.status = "skipped";
          result.warnings.push(
            `A project named "${String(input.name).trim()}" already exists in ${String(input.serviceArea)}. Skipped; the existing project is not changed.`,
          );
          result.input = null;
          continue;
        }
        const firstLine = seenInFile.get(key);
        if (firstLine !== undefined) {
          result.status = "error";
          result.errors = { name: [`Same name and service area as line ${firstLine} of this file`] };
          result.input = null;
          continue;
        }
        seenInFile.set(key, row.line);
      }
    }
    const count = (s: CreateRowResult["status"]) => rows.filter((r) => r.status === s).length;
    const counts = { rows: rows.length, ready: count("ready"), skipped: count("skipped"), errors: count("error") };
    return {
      mode: "create",
      fileErrors: parsed.fileErrors,
      fileWarnings: parsed.fileWarnings,
      columns: parsed.columns,
      rows,
      counts,
      canCommit: parsed.fileErrors.length === 0 && counts.errors === 0 && counts.ready > 0,
    };
  }

  /** Case- and whitespace-insensitive (name, service area) key. */
  static duplicateKey(name: string, serviceArea: string): string {
    return `${name.trim().replace(/\s+/g, " ").toLowerCase()}|${serviceArea}`;
  }

  // ---------------------------------------------------------------- wording update

  static async previewWording(csv: string, db: Reader = Db.client): Promise<WordingPreview> {
    return ImportService.buildWordingPreview(ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING), db);
  }

  static async commitWording(
    csv: string,
    adminEmail: string,
    db: PrismaClient = Db.client,
  ): Promise<{ updated: number; unchanged: number; preview: WordingPreview }> {
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING);
    const actor: Actor = { changedBy: adminEmail, comment: ImportService.SOURCE_WORDING };
    return db.$transaction(async (tx) => {
      const preview = await ImportService.buildWordingPreview(parsed, tx);
      if (!preview.canCommit) throw new ImportBlockedError(preview);
      for (const row of preview.rows) {
        if (row.status !== "change") continue;
        const patch: Partial<ProjectInput> = {};
        for (const c of row.changes) patch[ImportService.WORDING_FIELD[c.column]] = c.new;
        await ProjectService.updateInTx(tx, row.id, patch, actor);
      }
      return { updated: preview.counts.changed, unchanged: preview.counts.unchanged, preview };
    }, ImportService.TX_OPTIONS);
  }

  private static async buildWordingPreview(parsed: ParsedCsv, db: Reader): Promise<WordingPreview> {
    const rows: WordingRowResult[] = [];
    if (parsed.fileErrors.length === 0) {
      const ids = [...new Set(parsed.rows.map((r) => (r.cells.id ?? "").trim().toLowerCase()))].filter((id) =>
        ImportService.UUID_RE.test(id),
      );
      const found = ids.length ? await db.project.findMany({ where: { id: { in: ids } } }) : [];
      const byId = new Map<string, ProjectRecord>(found.map((p) => [p.id.toLowerCase(), p]));
      const seenIds = new Map<string, number>();

      for (const row of parsed.rows) {
        const id = (row.cells.id ?? "").trim().toLowerCase();
        const result: WordingRowResult = {
          line: row.line,
          id,
          name: (row.cells.name ?? "").trim(),
          status: "unchanged",
          changes: [],
          errors: {},
          cells: row.cells,
        };
        rows.push(result);
        const reject = (col: CsvColumn | "_row", msg: string) => {
          result.status = "error";
          (result.errors[col] ??= []).push(msg);
        };

        if (!id) {
          reject("id", "id is required to match a project. Export a fresh CSV to get ids.");
          continue;
        }
        if (!ImportService.UUID_RE.test(id)) {
          reject("id", `"${id}" is not a project id`);
          continue;
        }
        const firstLine = seenIds.get(id);
        if (firstLine !== undefined) {
          reject("id", `Same id as line ${firstLine} of this file`);
          continue;
        }
        seenIds.set(id, row.line);
        const existing = byId.get(id);
        if (!existing) {
          reject("id", "No project has this id");
          continue;
        }
        result.name = existing.name;
        if (existing.archivedAt) {
          reject("id", "This project is archived and cannot be updated");
          continue;
        }

        // Every column other than description/note/next_milestone/accomplishment must match the database exactly (after normalization).
        const { input: fileInput, errors: conversionErrors } = ProjectCsv.toInput(row);
        const dbInput = ProjectValidator.toInput(existing);
        const dbCells = ProjectCsv.toCells(existing);
        for (const [col, messages] of Object.entries(conversionErrors)) {
          for (const m of messages ?? []) reject(col as CsvColumn, m);
        }
        for (const col of parsed.columns) {
          if (col === "id" || ImportService.WORDING_COLUMNS.includes(col as WordingChange["column"])) continue;
          if (conversionErrors[col]) continue;
          const field = ProjectCsv.FIELD_BY_COLUMN[col];
          const fileValue = ImportService.comparable(field, fileInput[field]);
          const dbValue = ImportService.comparable(field, dbInput[field]);
          if (fileValue !== dbValue) {
            reject(
              col,
              `Changed from "${dbCells[col]}" to "${(row.cells[col] ?? "").trim()}". ${ImportService.LOCKED_MESSAGE}`,
            );
          }
        }

        // Diff the wording columns present in the file (old versus new). An absent column is unchanged.
        const wordingPatch: Partial<ProjectInput> = {};
        for (const col of ImportService.WORDING_COLUMNS) {
          if (row.cells[col] === undefined) continue;
          const field = ImportService.WORDING_FIELD[col];
          const next = ImportService.text(row.cells[col]);
          const old = existing[field];
          wordingPatch[field] = next;
          if (next !== old) result.changes.push({ column: col, old, new: next });
        }

        // Validate the merged project with the same rules as every save (note, description, milestone max...).
        const validation = ProjectValidator.validate({ ...dbInput, ...wordingPatch });
        if (!validation.ok) {
          for (const [col, messages] of Object.entries(ProjectCsv.columnErrors(validation.errors))) {
            for (const m of messages ?? []) reject(col as CsvColumn, m);
          }
        }
        if (result.status !== "error") result.status = result.changes.length ? "change" : "unchanged";
      }
    }
    const count = (s: WordingRowResult["status"]) => rows.filter((r) => r.status === s).length;
    const counts = { rows: rows.length, changed: count("change"), unchanged: count("unchanged"), errors: count("error") };
    return {
      mode: "wording",
      fileErrors: parsed.fileErrors,
      fileWarnings: parsed.fileWarnings,
      rows,
      counts,
      canCommit: parsed.fileErrors.length === 0 && counts.errors === 0 && counts.changed > 0,
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Convert a row and run ProjectValidator, returning errors keyed by CSV column. */
  private static validateRow(row: CsvRow): { input: Partial<ProjectInput>; errors: RowErrors } {
    const { input, errors: conversionErrors } = ProjectCsv.toInput(row);
    const errors: RowErrors = { ...conversionErrors };
    const validation = ProjectValidator.validate(input);
    if (!validation.ok) {
      for (const [col, messages] of Object.entries(ProjectCsv.columnErrors(validation.errors))) {
        // A conversion error already explains this column; skip the generic validator message.
        if (conversionErrors[col as CsvColumn]) continue;
        (errors[col as CsvColumn] ??= []).push(...(messages ?? []));
      }
    }
    return { input, errors };
  }

  /** Trimmed text, blank = null (same normalization ProjectValidator applies). */
  private static text(raw: string | undefined): string | null {
    const t = (raw ?? "").trim();
    return t === "" ? null : t;
  }

  /** A normalized string form of one field's value for equality checks. */
  private static comparable(field: keyof ProjectInput, value: unknown): string {
    if (value === undefined || value === null) return "";
    if (value instanceof Date) return DateOnly.fromDbDate(value) ?? "";
    if (typeof value === "string") {
      const t = value.trim();
      return field === "physicianChampionEmail" ? t.toLowerCase() : t;
    }
    return String(value);
  }
}
