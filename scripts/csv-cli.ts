/**
 * CLI for the project CSV import/export (same ImportService/ExportService as /admin/import).
 * Connects with DATABASE_URL (loaded from .env.local, then .env).
 *
 *   npm run import:csv -- path.csv [--commit] [--as admin@example.org]
 *   npm run import:csv -- path.csv --update-wording [--commit] [--as admin@example.org]
 *   npm run export:csv -- out.csv
 *
 * Without --commit it is a dry run (no writes). --commit requires an admin email (--as, or
 * IMPORT_ACTOR_EMAIL) that is listed in ADMIN_EMAILS; it becomes the history actor.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ExportService } from "@/lib/import/ExportService";
import { ImportBlockedError, ImportService, type ImportPreview, type RowErrors } from "@/lib/import/ImportService";

config({ path: [".env.local", ".env"], quiet: true });

class CsvCli {
  static async main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command === "export") return CsvCli.export(rest);
    if (command === "import") return CsvCli.import(rest);
    console.error("Usage: csv-cli.ts import <file.csv> [--update-wording] [--commit] [--as email] | export <out.csv>");
    return 2;
  }

  private static async export(args: string[]): Promise<number> {
    const out = args.find((a) => !a.startsWith("--"));
    if (!out) {
      console.error("Usage: npm run export:csv -- out.csv");
      return 2;
    }
    const { csv, count } = await ExportService.exportCsv(Db.client);
    writeFileSync(out, csv, "utf8");
    console.log(`Exported ${count} project(s) to ${out}`);
    return 0;
  }

  private static async import(args: string[]): Promise<number> {
    const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--as");
    const commit = args.includes("--commit");
    const wording = args.includes("--update-wording");
    const asIndex = args.indexOf("--as");
    const actor = (asIndex >= 0 ? args[asIndex + 1] : process.env.IMPORT_ACTOR_EMAIL)?.trim().toLowerCase();
    if (!file) {
      console.error("Usage: npm run import:csv -- path.csv [--update-wording] [--commit] [--as admin@example.org]");
      return 2;
    }
    if (commit && !AdminPolicy.isAdmin(actor)) {
      console.error("--commit needs an admin email (--as or IMPORT_ACTOR_EMAIL) that is listed in ADMIN_EMAILS and ALLOWED_EMAILS.");
      return 2;
    }
    const csv = readFileSync(file, "utf8");
    const db = Db.client;

    const preview = wording ? await ImportService.previewWording(csv, db) : await ImportService.previewCreate(csv, db);
    CsvCli.print(preview);
    if (!commit) {
      const hasErrors = preview.fileErrors.length > 0 || preview.rows.some((r) => r.status === "error");
      if (preview.canCommit) console.log("\nDry run only. Re-run with --commit to save.");
      else if (hasErrors) console.log("\nDry run only. Nothing can be saved until the problems above are fixed.");
      else console.log("\nDry run only. There is nothing to save in this file.");
      return hasErrors ? 1 : 0;
    }
    try {
      if (wording) {
        const r = await ImportService.commitWording(csv, actor!, db);
        console.log(`\nUpdated wording on ${r.updated} project(s); ${r.unchanged} unchanged.`);
      } else {
        const r = await ImportService.commitCreate(csv, actor!, db);
        console.log(`\nCreated ${r.created} project(s); ${r.skipped} skipped.`);
      }
      return 0;
    } catch (e) {
      if (e instanceof ImportBlockedError) {
        console.error(`\nNothing was saved. ${e.message}`);
        return 1;
      }
      throw e;
    }
  }

  private static messages(errors: RowErrors): string[] {
    return Object.entries(errors).flatMap(([col, msgs]) => (msgs ?? []).map((m) => (col === "_row" ? m : `${col}: ${m}`)));
  }

  private static print(preview: ImportPreview): void {
    for (const e of preview.fileErrors) console.log(`FILE ERROR: ${e}`);
    for (const w of preview.fileWarnings) console.log(`file warning: ${w}`);
    if (preview.mode === "create") {
      for (const r of preview.rows) {
        const name = (r.cells.name ?? "").trim();
        console.log(`line ${r.line} [${r.status}] ${name}`);
        for (const m of CsvCli.messages(r.errors)) console.log(`    error: ${m}`);
        for (const w of r.warnings) console.log(`    warning: ${w}`);
      }
      const c = preview.counts;
      console.log(`\n${c.rows} rows: ${c.ready} ready, ${c.skipped} skipped, ${c.errors} with errors`);
    } else {
      for (const r of preview.rows) {
        console.log(`line ${r.line} [${r.status}] ${r.name || r.id}`);
        for (const ch of r.changes) {
          console.log(`    ${ch.column}:\n      old: ${ch.old ?? "(blank)"}\n      new: ${ch.new ?? "(blank)"}`);
        }
        for (const m of CsvCli.messages(r.errors)) console.log(`    error: ${m}`);
      }
      const c = preview.counts;
      console.log(`\n${c.rows} rows: ${c.changed} with changes, ${c.unchanged} unchanged, ${c.errors} with errors`);
    }
  }
}

CsvCli.main(process.argv.slice(2))
  .then(async (code) => {
    if (Db.isConfigured()) await Db.client.$disconnect();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e);
    if (Db.isConfigured()) await Db.client.$disconnect().catch(() => {});
    process.exit(1);
  });
