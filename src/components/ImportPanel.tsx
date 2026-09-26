"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { commitImport, previewImport, type ImportMode } from "@/app/admin/import/actions";
import type { CsvColumn } from "@/lib/import/ProjectCsv";
import type { CreatePreview, ImportPreview, RowErrors, WordingPreview } from "@/lib/import/ImportService";

interface Props {
  adminEmail: string;
  templateColumns: CsvColumn[];
  limits: { rows: number; note: number; milestone: number };
}

class ImportCopy {
  static commitLabel(preview: ImportPreview): string {
    if (preview.mode === "create") {
      const n = preview.counts.ready;
      return `Import ${n} project${n === 1 ? "" : "s"}`;
    }
    const n = preview.counts.changed;
    return `Apply ${n} wording change${n === 1 ? "" : "s"}`;
  }

  static rowMessages(errors: RowErrors): string[] {
    return Object.entries(errors).flatMap(([col, msgs]) => (msgs ?? []).map((m) => (col === "_row" ? m : `${col}: ${m}`)));
  }
}

const btn = "inline-flex h-8 items-center rounded-control border border-line bg-input px-3 type-table-strong hover:bg-card";
const th = "sticky top-0 z-[1] h-9 border-b border-line bg-card px-2 text-left uppercase tracking-[.04em] text-muted type-label whitespace-nowrap";
const td = "border-b border-line px-2 py-1.5 align-top";
const errCell = "bg-(--status-off-track-dark-bg) text-(--status-off-track-dark-fg)";

export function ImportPanel({ adminEmail, templateColumns, limits }: Props) {
  const [mode, setMode] = useState<ImportMode>("create");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const runPreview = (nextMode: ImportMode, text: string) => {
    setMessage(null);
    startTransition(async () => {
      const r = await previewImport(nextMode, text);
      if (r.ok) setPreview(r.preview);
      else {
        setPreview(null);
        setMessage({ kind: "error", text: r.error });
      }
    });
  };

  const onFile = async (file: File | undefined) => {
    setPreview(null);
    setMessage(null);
    if (!file) return;
    if (file.size > 1_000_000) {
      setMessage({ kind: "error", text: "The file is too large. Split it into smaller files." });
      return;
    }
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    runPreview(mode, text);
  };

  const onMode = (next: ImportMode) => {
    setMode(next);
    setPreview(null);
    if (csv) runPreview(next, csv);
  };

  const onCommit = () => {
    if (!csv || !preview?.canCommit) return;
    startTransition(async () => {
      const r = await commitImport(mode, csv);
      if (r.ok) {
        setPreview(null);
        setCsv(null);
        setFileName(null);
        if (fileRef.current) fileRef.current.value = "";
        setMessage({
          kind: "ok",
          text:
            r.mode === "create"
              ? `Imported ${r.created} project${r.created === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} skipped)` : ""}.`
              : `Updated wording on ${r.updated} project${r.updated === 1 ? "" : "s"}.`,
        });
      } else {
        if (r.preview) setPreview(r.preview);
        setMessage({ kind: "error", text: r.error });
      }
    });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-topbar px-6 backdrop-blur-[20px]">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="grid size-[26px] place-items-center rounded-[6px] bg-accent type-label font-bold">SL</div>
          <span className="type-title">Service Line Portfolio</span>
        </Link>
        <div className="h-6 w-px bg-line" />
        <span className="type-table-strong">Import projects (admin)</span>
        <div className="flex-1" />
        <span className="type-caption text-muted">Signed in as {adminEmail}</span>
      </header>

      <main className="flex flex-col gap-4 px-6 pt-5 pb-6">
        <section className="flex flex-col gap-3 rounded-card border border-line bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <a className={btn} href="/admin/import/template" download>
              Download template
            </a>
            <a className={btn} href="/admin/import/export" download>
              Export CSV
            </a>
            <span className="type-caption text-muted">
              Columns: {templateColumns.join(", ")}. Export adds a leading id column.
            </span>
          </div>

          <fieldset className="flex flex-wrap gap-4 type-table">
            <legend className="mb-1 type-label text-muted uppercase tracking-[.04em]">Mode</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === "create"} onChange={() => onMode("create")} />
              New projects (duplicates by name and service area are skipped, never overwritten)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === "wording"} onChange={() => onMode("wording")} />
              Wording update (matched by id; only description, note and next_milestone may change)
            </label>
          </fieldset>

          <label className="flex flex-wrap items-center gap-3 type-table">
            <span className="type-table-strong">CSV file</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="type-table file:mr-3 file:h-8 file:rounded-control file:border file:border-line file:bg-input file:px-3 file:text-fg"
            />
            {fileName && <span className="text-muted">{fileName}</span>}
          </label>
          <p className="type-caption text-muted">
            Up to {limits.rows} rows per file. Note max {limits.note} characters; next milestone max {limits.milestone}{" "}
            characters. Dates as YYYY-MM-DD or M/D/YYYY. Nothing is saved until you confirm, and a failed import saves
            nothing.
          </p>
        </section>

        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={`rounded-card border border-line bg-card px-3 py-2 ${message.kind === "error" ? "text-danger" : ""}`}
          >
            {message.text}
          </p>
        )}
        {pending && <p className="type-caption text-muted">Working...</p>}

        {preview && (
          <section className="flex flex-col gap-3">
            {preview.fileErrors.length > 0 && (
              <ul role="alert" className="rounded-card border border-line bg-card px-4 py-2 text-danger">
                {preview.fileErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            {preview.fileWarnings.length > 0 && (
              <ul className="rounded-card border border-line bg-card px-4 py-2 text-muted">
                {preview.fileWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <span className="type-table">
                {preview.mode === "create"
                  ? `${preview.counts.rows} rows: ${preview.counts.ready} ready, ${preview.counts.skipped} skipped, ${preview.counts.errors} with errors`
                  : `${preview.counts.rows} rows: ${preview.counts.changed} with changes, ${preview.counts.unchanged} unchanged, ${preview.counts.errors} with errors`}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={onCommit}
                disabled={!preview.canCommit || pending}
                className="h-8 rounded-control bg-accent px-3.5 text-white type-table-strong disabled:opacity-60"
              >
                {ImportCopy.commitLabel(preview)}
              </button>
            </div>
            {!preview.canCommit && preview.fileErrors.length === 0 && (
              <p className="type-caption text-muted">
                {preview.rows.some((r) => r.status === "error")
                  ? "Fix the highlighted rows and upload the file again. Nothing is imported while any row has an error."
                  : "There is nothing to import in this file."}
              </p>
            )}
            {preview.mode === "create" ? (
              <CreateTable preview={preview} />
            ) : (
              <WordingTable preview={preview} />
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label: Record<string, string> = {
    ready: "Ready",
    skipped: "Skipped",
    error: "Error",
    change: "Change",
    unchanged: "Unchanged",
  };
  return <span className={status === "error" ? "text-danger type-table-strong" : "type-table-strong"}>{label[status] ?? status}</span>;
}

function CreateTable({ preview }: { preview: CreatePreview }) {
  const cols = preview.columns.filter((c) => c !== "id");
  return (
    <div className="max-h-[70vh] overflow-auto rounded-card border border-line bg-card">
      <table className="w-full border-separate border-spacing-0 type-table">
        <thead>
          <tr>
            <th className={th}>Line</th>
            <th className={th}>Result</th>
            {cols.map((c) => (
              <th key={c} className={th}>
                {c}
              </th>
            ))}
            <th className={th}>Problems</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r) => (
            <tr key={r.line}>
              <td className={td}>{r.line}</td>
              <td className={td}>
                <StatusBadge status={r.status} />
              </td>
              {cols.map((c) => (
                <td key={c} className={`${td} max-w-[240px] break-words ${r.errors[c] ? errCell : ""}`}>
                  {r.cells[c]}
                </td>
              ))}
              <td className={`${td} min-w-[260px]`}>
                {ImportCopy.rowMessages(r.errors).map((m) => (
                  <div key={m} className="text-danger">
                    {m}
                  </div>
                ))}
                {r.warnings.map((w) => (
                  <div key={w} className="text-muted">
                    {w}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WordingTable({ preview }: { preview: WordingPreview }) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded-card border border-line bg-card">
      <table className="w-full border-separate border-spacing-0 type-table">
        <thead>
          <tr>
            <th className={th}>Line</th>
            <th className={th}>Project</th>
            <th className={th}>Result</th>
            <th className={th}>Field</th>
            <th className={th}>Old</th>
            <th className={th}>New</th>
            <th className={th}>Problems</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((r) => {
            const changes = r.changes.length ? r.changes : [null];
            return changes.map((c, i) => (
              <tr key={`${r.line}-${i}`}>
                {i === 0 && (
                  <>
                    <td className={td} rowSpan={changes.length}>
                      {r.line}
                    </td>
                    <td className={`${td} max-w-[240px] break-words`} rowSpan={changes.length}>
                      {r.name || r.id}
                    </td>
                    <td className={td} rowSpan={changes.length}>
                      <StatusBadge status={r.status} />
                    </td>
                  </>
                )}
                <td className={`${td} ${c && r.errors[c.column] ? errCell : ""}`}>{c?.column ?? ""}</td>
                <td className={`${td} max-w-[320px] break-words text-muted line-through`}>{c ? (c.old ?? "(blank)") : ""}</td>
                <td className={`${td} max-w-[320px] break-words ${c && r.errors[c.column] ? errCell : ""}`}>{c ? (c.new ?? "(blank)") : ""}</td>
                {i === 0 && (
                  <td className={`${td} min-w-[260px]`} rowSpan={changes.length}>
                    {ImportCopy.rowMessages(r.errors).map((m) => (
                      <div key={m} className="text-danger">
                        {m}
                      </div>
                    ))}
                  </td>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}
