import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiToolsPanel } from "@/components/AiToolsPanel";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import type { AiModelDb } from "@/lib/services/AiModelService";
import type { AiSettingsDb } from "@/lib/services/AiSettingsService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";

/** The provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

export const metadata: Metadata = { title: C.PAGE_TITLE };

/**
 * AI tools (steps 4 to 9). Admins only, like editing: anyone else gets a 404. Every tool proposes; a person applies or
 * rejects each line. Nothing here reads or writes snapshots, PDFs, report_artifacts or handoff.json.
 */
export default async function AiToolsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  let notes: Record<string, string | null> = Object.fromEntries(AiFeatureFlags.TOOL_FEATURES.map((f) => [f, C.AI_OFF_NOTE]));
  if (Db.isConfigured()) {
    try {
      notes = await AiToolsReadiness.notes(Db.client as unknown as AiModelDb & AiSettingsDb, AiFeatureFlags.TOOL_FEATURES);
    } catch {
      // Tables not migrated yet (Vercel previews skip migrations): every tool shows disabled.
    }
  }
  const section = "flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4 backdrop-blur-[20px]";
  return (
    <main className="pb-page mx-auto flex max-w-[1040px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="type-title whitespace-nowrap">{C.PAGE_TITLE}</h1>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">{C.PAGE_INTRO}</p>

      <section className={section} aria-labelledby="ai-tool-meeting-heading" id="meeting-notes">
        <h2 id="ai-tool-meeting-heading" className="type-heading">
          {C.MEETING_TITLE}
        </h2>
        <AiToolsPanel feature="meeting_notes" label={C.MEETING_LABEL} help={C.MEETING_HELP} placeholder={C.MEETING_PLACEHOLDER} disabledNote={notes.meeting_notes ?? null} rows={8} />
      </section>
    </main>
  );
}
