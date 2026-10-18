import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiDraftProjectPanel } from "@/components/AiDraftProjectPanel";
import { AiNextStepPanel } from "@/components/AiNextStepPanel";
import { AiBulkEditPanel } from "@/components/AiBulkEditPanel";
import { AiMeetingNotesPanel } from "@/components/AiMeetingNotesPanel";
import { AiToolsPanel } from "@/components/AiToolsPanel";
import { AiVoiceChatPanel } from "@/components/AiVoiceChatPanel";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import type { AiModelDb } from "@/lib/services/AiModelService";
import type { AiSettingsDb } from "@/lib/services/AiSettingsService";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiToolsService, type AiToolsDb } from "@/lib/services/AiToolsService";

/** The provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

export const metadata: Metadata = { title: C.PAGE_TITLE };

/**
 * AI tools (steps 4 to 10). Admins only, like editing: anyone else gets a 404. Every tool proposes; a person applies or
 * rejects each line. Related-project links are no longer offered here (the table and the flag stay). Nothing here reads or writes snapshots, PDFs, report_artifacts or handoff.json.
 */
export default async function AiToolsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  let notes: Record<string, string | null> = Object.fromEntries(AiFeatureFlags.TOOL_FEATURES.map((f) => [f, C.AI_OFF_NOTE]));
  let dictationNote: string | null = C.AI_OFF_NOTE;
  let voiceNote: string | null = C.AI_OFF_NOTE;
  let projects: { id: string; name: string }[] = [];
  if (Db.isConfigured()) {
    try {
      notes = await AiToolsReadiness.notes(Db.client as unknown as AiModelDb & AiSettingsDb, AiFeatureFlags.TOOL_FEATURES);
      dictationNote = await AiToolsReadiness.dictationNote(Db.client as unknown as AiModelDb & AiSettingsDb);
      voiceNote = await AiToolsReadiness.voiceChatNote(Db.client as unknown as AiModelDb & AiSettingsDb);
      const scope = await ServiceLineAccess.activeFor(viewer);
      projects = (await AiToolsService.projects(Db.client as unknown as AiToolsDb, scope)).map((p) => ({ id: p.id, name: p.name }));
    } catch {
      // Tables not migrated yet (Vercel previews skip migrations): every tool shows disabled.
    }
  }
  /** Feature toggle OFF: the card is hidden. Feature ON but model off: the card stays, paused with the note (3b-2). */
  const shown = (feature: string) => notes[feature] !== C.FEATURE_OFF_NOTE;
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

      {shown("meeting_notes") && (
      <section className={section} aria-labelledby="ai-tool-meeting-heading" id="meeting-notes">
        <h2 id="ai-tool-meeting-heading" className="type-heading">
          {C.MEETING_TITLE}
        </h2>
        <AiMeetingNotesPanel disabledNote={notes.meeting_notes ?? null} {...(dictationNote === C.FEATURE_OFF_NOTE ? {} : { dictation: { disabledNote: dictationNote } })} />
      </section>
      )}

      {shown("bulk_edit") && (
      <section className={section} aria-labelledby="ai-tool-bulk-heading" id="bulk-edit">
        <h2 id="ai-tool-bulk-heading" className="type-heading">
          {C.BULK_TITLE}
        </h2>
        <AiBulkEditPanel disabledNote={notes.bulk_edit ?? null} />
      </section>
      )}

      {shown("quick_capture") && (
      <section className={section} aria-labelledby="ai-tool-capture-heading" id="quick-capture">
        <h2 id="ai-tool-capture-heading" className="type-heading">
          {C.CAPTURE_TITLE}
        </h2>
        <AiToolsPanel feature="quick_capture" label={C.CAPTURE_LABEL} help={C.CAPTURE_HELP} placeholder={C.CAPTURE_PLACEHOLDER} disabledNote={notes.quick_capture ?? null} rows={2} dictation={dictationNote === C.FEATURE_OFF_NOTE ? undefined : { disabledNote: dictationNote }} />
      </section>
      )}

      {shown("next_step") && (
      <section className={section} aria-labelledby="ai-tool-next-heading" id="next-step">
        <h2 id="ai-tool-next-heading" className="type-heading">
          {C.NEXT_TITLE}
        </h2>
        <AiNextStepPanel projects={projects} disabledNote={notes.next_step ?? null} />
      </section>
      )}

      {shown("request_to_project") && (
      <section className={section} aria-labelledby="ai-tool-request-heading" id="request-to-project">
        <h2 id="ai-tool-request-heading" className="type-heading">
          {C.REQUEST_TITLE}
        </h2>
        <AiDraftProjectPanel disabledNote={notes.request_to_project ?? null} />
      </section>
      )}

      {shown("meeting_brief") && (
      <section className={section} aria-labelledby="ai-tool-brief-heading" id="meeting-brief">
        <h2 id="ai-tool-brief-heading" className="type-heading">
          {C.PLAYBOOK_TITLE}
        </h2>
        {/* Meeting Playbook item: the brief became the playbook, on its own full-width page. */}
        <p className="text-muted type-caption">{C.PLAYBOOK_INTRO}</p>
        <Link href="/playbook" className="self-start rounded-control border border-line px-3.5 py-1.5 text-fg type-table-strong hover:border-accent" data-testid="ai-tools-playbook-link">
          {C.PLAYBOOK_OPEN}
        </Link>
      </section>
      )}

      {voiceNote !== C.FEATURE_OFF_NOTE && (
      <section className={section} aria-labelledby="ai-tool-voice-heading" id="voice-chat">
        <h2 id="ai-tool-voice-heading" className="type-heading">
          {C.VOICE_CHAT_TITLE}
        </h2>
        <AiVoiceChatPanel disabledNote={voiceNote} />
      </section>
      )}
    </main>
  );
}
