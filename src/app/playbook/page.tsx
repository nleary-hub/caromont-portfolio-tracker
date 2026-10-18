import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiPlaybookForm, AiPlaybookNotes, AiPlaybookSaved, AiPlaybookView } from "@/components/AiPlaybook";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiPlaybookRecord } from "@/lib/ai/playbook/AiPlaybookModel";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiActionService } from "@/lib/services/AiActionService";
import type { AiModelDb } from "@/lib/services/AiModelService";
import { AiPlaybookService, type AiPlaybookDb } from "@/lib/services/AiPlaybookService";
import type { AiSettingsDb } from "@/lib/services/AiSettingsService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";

/** The provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

export const metadata: Metadata = { title: C.PLAYBOOK_TITLE };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Meeting Playbook (replaces the pre-meeting brief card): a full-width page. Admins only, like the AI tools; anyone
 * else gets a 404. ?id= reopens a saved playbook; ?ids=&label= comes from the dashboard's selected rows or current
 * filter. Nothing here reads or writes snapshots, PDFs, report_artifacts or handoff.json.
 */
export default async function PlaybookPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  const params = await searchParams;
  let note: string | null = C.AI_OFF_NOTE;
  let notesNote: string | null = C.AI_OFF_NOTE;
  let dictationNote: string | null = C.AI_OFF_NOTE;
  let departments: string[] = [];
  let owners: string[] = [];
  let saved: AiPlaybookRecord[] = [];
  let current: AiPlaybookRecord | null = null;
  if (Db.isConfigured()) {
    try {
      const db = Db.client as unknown as AiPlaybookDb & AiModelDb & AiSettingsDb;
      const notes = await AiToolsReadiness.notes(db, ["meeting_brief", "meeting_notes"]);
      note = notes.meeting_brief ?? null;
      notesNote = notes.meeting_notes ?? null;
      dictationNote = await AiToolsReadiness.dictationNote(db);
      const scope = await ServiceLineAccess.activeFor(viewer);
      const lists = await AiActionService.lists(db, scope);
      departments = lists.departments.map((d) => d.name);
      owners = [...lists.owners];
      saved = await AiPlaybookService.list(db, viewer, scope);
      const id = one(params.id);
      current = id ? (saved.find((r) => r.id === id) ?? (await AiPlaybookService.get(db, viewer, scope, id))) : null;
    } catch {
      // Tables not migrated yet (Vercel previews skip migrations): the form shows disabled.
    }
  }
  const ids = (one(params.ids) ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const picked = ids.length ? { ids, label: (one(params.label) ?? "").slice(0, 120) || `${ids.length} projects from the dashboard` } : null;
  return (
    <main className="pb-page mx-auto flex max-w-[1400px] flex-col gap-4 px-6 py-6 print:max-w-none print:p-0">
      <div className="flex items-center justify-between gap-4 print:hidden">
        <h1 className="type-title whitespace-nowrap">{C.PLAYBOOK_TITLE}</h1>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] print:block">
        <div className="flex min-w-0 flex-col gap-4">
          <AiPlaybookForm disabledNote={note} departments={departments} owners={owners} picked={picked} />
          {current && <AiPlaybookView record={current} />}
          {current && <AiPlaybookNotes record={current} disabledNote={notesNote} dictationNote={dictationNote} />}
        </div>
        <AiPlaybookSaved saved={saved} currentId={current?.id ?? null} />
      </div>
    </main>
  );
}
