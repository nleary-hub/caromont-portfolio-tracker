"use server";

import { AdminGate } from "@/lib/auth/AdminGate";
import { ImportBlockedError, ImportService, type ImportPreview } from "@/lib/import/ImportService";

export type ImportMode = "create" | "wording";

export type PreviewResult = { ok: true; preview: ImportPreview } | { ok: false; error: string };

export type CommitResult =
  | { ok: true; mode: "create"; created: number; skipped: number }
  | { ok: true; mode: "wording"; updated: number; unchanged: number }
  | { ok: false; error: string; preview?: ImportPreview };

class ImportActionsSupport {
  /** 1 MB of CSV is far more than the row limit needs. */
  static readonly MAX_CHARS = 1_000_000;

  static check(mode: unknown, csv: unknown): string | null {
    if (mode !== "create" && mode !== "wording") return "Unknown import mode.";
    if (typeof csv !== "string" || csv.length === 0) return "Choose a CSV file first.";
    if (csv.length > ImportActionsSupport.MAX_CHARS) return "The file is too large. Split it into smaller files.";
    return null;
  }
}

// Server Functions can be POSTed directly, so each one re-checks the admin session (404 for non-admins).

export async function previewImport(mode: ImportMode, csv: string): Promise<PreviewResult> {
  await AdminGate.requireAdmin();
  const problem = ImportActionsSupport.check(mode, csv);
  if (problem) return { ok: false, error: problem };
  try {
    const preview = mode === "create" ? await ImportService.previewCreate(csv) : await ImportService.previewWording(csv);
    return { ok: true, preview };
  } catch (e) {
    console.error("CSV import preview failed", e);
    return { ok: false, error: "The preview could not be generated. Check the database connection and try again." };
  }
}

export async function commitImport(mode: ImportMode, csv: string): Promise<CommitResult> {
  const admin = await AdminGate.requireAdmin();
  const problem = ImportActionsSupport.check(mode, csv);
  if (problem) return { ok: false, error: problem };
  try {
    if (mode === "create") {
      const r = await ImportService.commitCreate(csv, admin);
      return { ok: true, mode, created: r.created, skipped: r.skipped };
    }
    const r = await ImportService.commitWording(csv, admin);
    return { ok: true, mode, updated: r.updated, unchanged: r.unchanged };
  } catch (e) {
    if (e instanceof ImportBlockedError) {
      return { ok: false, error: "Nothing was saved. The file has problems (shown below).", preview: e.preview };
    }
    console.error("CSV import commit failed", e);
    return { ok: false, error: "Nothing was saved. The import failed and was rolled back." };
  }
}
