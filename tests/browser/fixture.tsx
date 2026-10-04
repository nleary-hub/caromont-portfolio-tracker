import { createRoot } from "react-dom/client";
import { ProjectDashboard, type AdminDashboardProps } from "../../src/components/ProjectDashboard";
import { ServiceLine } from "../../src/lib/domain/ServiceLine";
import { ViewSettings } from "../../src/lib/domain/ViewSettings";
import { ProjectFormModel } from "../../src/lib/projects/ProjectFormModel";
import type { DashboardRow } from "../../src/lib/dashboard/DashboardViewModel";

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
const counts = { NotStarted: 0, OnTrack: 3, AtRisk: 0, OffTrack: 0, OnHold: 0, Complete: 0, Cancelled: 0 };
const admin: AdminDashboardProps = {
  viewSettings: { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") },
  pickerCounts: { dashboard: counts, report: counts }, hiddenFromReportIds: [],
  saveViewSettingsAction: noop, setProjectHiddenAction: noop, deleteProjectAction: noop,
  ownerSuggestions: ["Fictional Owner"], requesterSuggestions: ["Fictional Requester"],
  setPeopleFieldAction: noop, menuItems: [],
  formValues: Object.fromEntries(rows.map(row => [row.id, ProjectFormModel.fromSource({ ...row,
    accomplishment: null, description: null, completedOn: null })])),
  milestoneSteps: {}, templates: [], saveMilestonesAction: async () => ({ ok: true, steps: [] }),
  saveProjectFormAction: async () => ({ ok: true, id: "fictional-0" }),
  createProjectAction: async () => ({ ok: true, id: "fictional-new" }),
  saveColumnLayoutAction: noop, saveRowOrderAction: noop, resetRowOrderAction: noop,
};
createRoot(document.getElementById("root")!).render(
  <ProjectDashboard rows={rows} columns={ViewSettings.visibleColumns(admin.viewSettings.dashboard)}
    today="2026-10-04" userEmail="fictional@example.org" userName="Fictional Reviewer"
    latestReport={null} loadError={null} serviceLine={ServiceLine.SEED} admin={admin}
    signOutAction={async () => {}} historyAction={async id => {
      // A late result must never reintroduce a previous project's history.
      await new Promise(resolve => setTimeout(resolve, id === "fictional-0" ? 120 : 20));
      return { title: "History (1)", previously: null, entries: [{ key: `history-${id}`, meta: "Fictional author",
        text: `History for ${id}`, hollow: false }] };
    }} />
);
