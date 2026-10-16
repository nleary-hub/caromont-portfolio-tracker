import { createRoot } from "react-dom/client";
import { AiSettingsForm } from "../../src/components/AiSettingsForm";
import { AiFeaturesPanel } from "../../src/components/AiModelsPanel";
import { OpenAiModelListProvider } from "../../src/components/useOpenAiModelList";
import { ProjectDashboard, type AdminDashboardProps } from "../../src/components/ProjectDashboard";
import { ServiceLine } from "../../src/lib/domain/ServiceLine";
import { ViewSettings } from "../../src/lib/domain/ViewSettings";
import { ProjectFormModel } from "../../src/lib/projects/ProjectFormModel";
import type { DashboardRow } from "../../src/lib/dashboard/DashboardViewModel";
import { DependencyGraph, type DependencyEdge } from "../../src/lib/projects/DependencyGraph";

// Fictional data and in-memory actions only. No auth, database, network actions or production configuration.
const rows: DashboardRow[] = ["Zulu", "Alpha", "Bravo"].map((name, i) => ({
  id: `fictional-${i}`, name: `${name} fictional project`, serviceArea: "Cath", owner: null,
  physicianChampion: null, requesterNotApplicable: false, contractsLead: null,
  status: "OnTrack", statusLabel: "On track", nextMilestone: `${name} milestone`,
  dueDate: "2026-12-01", targetCompletion: null, percentComplete: i * 10,
  note: `${name} unique note`, inforRequestNumber: 100 + i, includeInReport: true,
  changed: false, overdue: false, updatedOn: "2026-10-03", stale: false,
}));
const noop = async () => null;
// Fictional dependencies: Zulu is blocked by Bravo, and Alpha is blocked by Zulu (so Zulu blocked by Alpha is a loop).
let edges: DependencyEdge[] = [{ projectId: "fictional-0", blockedById: "fictional-2" }, { projectId: "fictional-1", blockedById: "fictional-0" }];
const depView = (id: string) => {
  const listed = new Set(edges.filter(e => e.projectId === id).map(e => e.blockedById));
  const all = rows.map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true as const, view: { blockedBy: all.filter(r => listed.has(r.id)), options: all.filter(r => r.id !== id && !listed.has(r.id)) } };
};
const counts = { NotStarted: 0, OnTrack: 3, AtRisk: 0, OffTrack: 0, OnHold: 0, Complete: 0, Cancelled: 0 };
const admin: AdminDashboardProps = {
  viewSettings: { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") },
  pickerCounts: { dashboard: counts, report: counts }, hiddenFromReportIds: [],
  saveViewSettingsAction: noop, setProjectHiddenAction: noop, deleteProjectAction: noop,
  ownerSuggestions: ["Fictional Owner"], requesterSuggestions: ["Fictional Requester"],
  milestoneOwnerOptions: ["Fictional Contracts Lead", "Fictional Owner", "Fictional Requester"],
  setPeopleFieldAction: noop, menuItems: [],
  formValues: Object.fromEntries(rows.map(row => [row.id, ProjectFormModel.fromSource({ ...row,
    accomplishment: null, description: null, completedOn: null })])),
  // Fictional checklist on Zulu; every save is recorded on window.__milestoneSaves so tests can read the exact payload.
  milestoneSteps: { "fictional-0": [{ id: "fictional-step-1", name: "Fictional vendor quote", dueDate: "2026-11-12", done: false, doneAt: null, checkedBy: null, checkedAt: null, position: 0, sourceTemplateId: null, owner: null }] },
  templates: [], saveMilestonesAction: async (_projectId, edit) => {
    const w = window as unknown as { __milestoneSaves?: unknown[] };
    (w.__milestoneSaves ??= []).push(JSON.parse(JSON.stringify(edit)));
    return { ok: true, steps: edit.drafts.map((d, i) => ({ id: d.id ?? `fictional-new-${i}`, name: d.name, dueDate: d.dueDate || null, done: d.done, doneAt: null, checkedBy: null, checkedAt: null, position: i, sourceTemplateId: d.sourceTemplateId, owner: d.owner ?? null })) };
  },
  // Every form save is recorded on window.__formSaves. ?save=fail: the save fails; ?save=slow: it takes 1.5 s.
  saveProjectFormAction: async (id, changes) => {
    const w = window as unknown as { __formSaves?: unknown[] };
    (w.__formSaves ??= []).push({ id, changes: JSON.parse(JSON.stringify(changes)) });
    const mode = new URLSearchParams(window.location.search).get("save");
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 1500));
    if (mode === "fail") return { ok: false, error: "Fictional save failure. Try again." };
    return { ok: true, id };
  },
  createProjectAction: async () => ({ ok: true, id: "fictional-new" }),
  saveColumnLayoutAction: noop, saveRowOrderAction: noop, resetRowOrderAction: noop,
  dependencyActions: {
    load: async id => depView(id),
    add: async (id, by) => {
      const problem = DependencyGraph.check(edges, id, by);
      if (problem) return { ok: false, error: DependencyGraph.MESSAGES[problem] };
      edges.push({ projectId: id, blockedById: by });
      return depView(id);
    },
    remove: async (id, by) => {
      edges = edges.filter(e => !(e.projectId === id && e.blockedById === by));
      return depView(id);
    },
  },
};
// ?ai=list or ?ai=failed: Admin > AI settings pickers with a fictional OpenAI model list, or the list-failed fallback.
const aiMode = new URLSearchParams(window.location.search).get("ai");
const aiList = aiMode === "failed" ? { ok: false as const, error: "fictional failure" } : { ok: true as const, models: [
  { id: "gpt-example-mini", kind: "chat" as const }, { id: "gpt-example-pro", kind: "chat" as const }, { id: "gpt-example-nano", kind: "chat" as const },
  { id: "gpt-live-example", kind: "realtime" as const }, { id: "gpt-example-realtime", kind: "realtime" as const }, { id: "gpt-example-realtime-mini", kind: "realtime" as const }, { id: "gpt-example-transcribe", kind: "transcription" as const }] };
// &vi=filled or &vi=over: the voice chat instructions field with fictional text (over = past the 4,000 cap).
const vi = new URLSearchParams(window.location.search).get("vi");
const voiceText = vi === "over" ? "Keep answers short and friendly for the fictional example team. ".repeat(66) : vi === "filled" ? "Keep answers short and friendly for the fictional example team.\nMention the next milestone first, then the due date." : "";
const aiView = { baseUrl: "", azureEndpoint: "", azureDeployment: "", encryption: { ready: true, problem: null }, modelOff: false, enabled: true, ready: true, provider: "openai" as const, model: "gpt-example-mini", key: { set: true, readable: true, last4: "WXYZ", setAt: null, setBy: null } };
createRoot(document.getElementById("root")!).render(aiMode ? (
  <OpenAiModelListProvider initial={aiList}>
  <main className="pb-page mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-6">
    <section className="relative z-20 flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4"><AiSettingsForm view={aiView as never} keySavedLine={null} dbReady modelOptions={["gpt-example-mini"]} /></section>
    <section className="flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4"><AiFeaturesPanel dbReady features={[{ feature: "voice_chat", label: "Voice chat", enabled: true, killedByEnv: false, envName: "AI_VOICE_CHAT", ownModel: true, model: null, instructions: voiceText } as never]} modelOptions={{ realtime: ["gpt-live-example", "gpt-example-realtime"] }} /></section>
  </main>
  </OpenAiModelListProvider>
) : (
  <ProjectDashboard rows={rows} columns={ViewSettings.visibleColumns(admin.viewSettings.dashboard)}
    today="2026-10-04" userEmail="fictional@example.org" userName="Fictional Reviewer"
    latestReport={null} loadError={null} serviceLine={ServiceLine.SEED}
    // ?viewer=readonly: the same dashboard for a non-admin (the drawer shows the fields read-only).
    admin={new URLSearchParams(window.location.search).get("viewer") === "readonly" ? undefined : admin}
    completedFiscalYear={new URLSearchParams(window.location.search).has("fy") ? { label: "FY27", start: "2026-07-01", count: 4 } : undefined}
    signOutAction={async () => {}} historyAction={async id => {
      // A late result must never reintroduce a previous project's history.
      await new Promise(resolve => setTimeout(resolve, id === "fictional-0" ? 120 : 20));
      return { title: "History (1)", previously: id === "fictional-1" ? "Previously REQ-00042" : null, notes: [], steps: [], entries: [{ key: `history-${id}`, meta: "Fictional author",
        text: `History for ${id}`, hollow: false }] };
    }} />
));
