import type { DependencyActionResult } from "../../src/app/actions/dependencies";
import type { DependencyActions } from "../../src/components/DependenciesSection";
import type { DashboardRow } from "../../src/lib/dashboard/DashboardViewModel";
import { BlockerRules } from "../../src/lib/projects/BlockerRules";
import { DependencyCopy } from "../../src/lib/projects/DependencyCopy";
import { DependencyGraph } from "../../src/lib/projects/DependencyGraph";
import type { BlockerDto, BlockerInput, DependencyInput, DependencyView } from "../../src/lib/services/ProjectDependencyService";

/**
 * ?deps=demo | empty | fail: fictional projects, dependencies and external blockers for the drawer "Dependencies &
 * blockers" section, with in-memory actions that follow the server's rules (cycle, duplicate, note and field limits).
 * ?deps=fail: every save fails with the plain save error. Fictional names only; no network, database or auth.
 */
export class DepsFixture {
  static readonly TODAY = "2026-10-17";
  static readonly PEOPLE = ["Jordan Pike", "Priya Nandakumar", "Sam Okafor"];

  static readonly PROJECTS: { id: string; name: string; status: string; label: string; due: string | null }[] = [
    { id: "dep-0", name: "Imaging Scheduler Upgrade", status: "Complete", label: "Complete", due: null },
    { id: "dep-1", name: "Atrium Wayfinding Refresh", status: "OnTrack", label: "On track", due: "2026-11-18" },
    { id: "dep-2", name: "Lobby Kiosk Rollout", status: "AtRisk", label: "At risk", due: "2026-11-04" },
    { id: "dep-3", name: "Pharmacy Carousel Install", status: "OffTrack", label: "Off track", due: "2026-12-02" },
    { id: "dep-4", name: "Clinic Signage Package", status: "NotStarted", label: "Not started", due: "2027-01-15" },
    { id: "dep-5", name: "Badge Reader Expansion", status: "OnHold", label: "On hold", due: "2026-12-10" },
  ];

  static readonly STEPS: Record<string, { id: string; name: string; done: boolean }[]> = {
    "dep-2": [
      { id: "st-1", name: "Kiosk pilot", done: false },
      { id: "st-2", name: "Go-live", done: false },
    ],
    "dep-1": [{ id: "st-3", name: "Design sign-off", done: false }],
  };

  edges: { projectId: string; blockedById: string; note: string | null; milestoneId: string | null; since: string }[] = [];
  blockers: (Omit<BlockerDto, "milestone"> & { projectId: string; milestoneId: string | null })[] = [];
  seq = 0;

  constructor(readonly mode: string) {
    if (mode === "empty") return;
    this.edges = [
      { projectId: "dep-2", blockedById: "dep-0", note: "Needs the new check-in screens", milestoneId: "st-1", since: "2026-10-02" },
      { projectId: "dep-2", blockedById: "dep-3", note: null, milestoneId: null, since: "2026-10-09" },
      { projectId: "dep-1", blockedById: "dep-2", note: "Kiosk locations set the sign plan", milestoneId: "st-3", since: "2026-10-05" },
      { projectId: "dep-4", blockedById: "dep-2", note: null, milestoneId: null, since: "2026-10-12" },
    ];
    const b = (projectId: string, x: Partial<DepsFixture["blockers"][number]>) =>
      this.blockers.push({ id: `blk-${++this.seq}`, projectId, description: "", waitingOn: "", since: "2026-10-03", followUpOn: null, followUpOwner: null, milestoneId: null, resolvedOn: null, resolvedBy: null, resolution: null, ...x });
    b("dep-2", { description: "Kiosk enclosure quote", waitingOn: "Northbeam Interiors", since: "2026-10-03", followUpOn: "2026-10-15", followUpOwner: "Priya Nandakumar" });
    b("dep-2", { description: "Network drop survey", waitingOn: "Example IT Facilities", since: "2026-10-10", followUpOn: "2026-10-24", followUpOwner: "Sam Okafor", milestoneId: "st-2" });
    b("dep-2", { description: "Revised enclosure drawings", waitingOn: "Northbeam Interiors", since: "2026-09-21", resolvedOn: "2026-10-12", resolvedBy: "Jordan Pike", resolution: "Vendor sent revised quote" });
    b("dep-2", { description: "Electrical permit", waitingOn: "Example County permits office", since: "2026-09-15", resolvedOn: "2026-10-01", resolvedBy: "Priya Nandakumar", resolution: "Permit approved" });
  }

  static rows(): DashboardRow[] {
    return DepsFixture.PROJECTS.map((p, i) => ({
      id: p.id, name: p.name, serviceArea: "Cath", owner: null, physicianChampion: null, requesterNotApplicable: false, contractsLead: null,
      status: p.status, statusLabel: p.label, nextMilestone: DepsFixture.STEPS[p.id]?.[0]?.name ?? null, dueDate: p.due, targetCompletion: null,
      percentComplete: i * 15, note: `Fictional note for ${p.name}`, inforRequestNumber: 200 + i, includeInReport: true,
      changed: false, overdue: false, updatedOn: "2026-10-10", stale: false,
    })) as unknown as DashboardRow[];
  }

  private name(id: string) {
    return DepsFixture.PROJECTS.find((p) => p.id === id)!;
  }

  private step(id: string | null) {
    if (!id) return null;
    for (const list of Object.values(DepsFixture.STEPS)) for (const s of list) if (s.id === id) return { id: s.id, name: s.name };
    return null;
  }

  view(id: string, canEdit = true): DependencyView {
    const other = (pid: string) => ({ id: pid, name: this.name(pid).name, status: this.name(pid).status as never });
    const sort = <T extends { project: { name: string } }>(a: T, b: T) => a.project.name.localeCompare(b.project.name);
    const blockedBy = this.edges.filter((e) => e.projectId === id).map((e) => ({ project: other(e.blockedById), note: e.note, milestone: this.step(e.milestoneId), since: e.since })).sort(sort);
    const blocking = this.edges.filter((e) => e.blockedById === id).map((e) => ({ project: other(e.projectId), note: e.note, milestone: this.step(e.milestoneId), since: e.since })).sort(sort);
    const dto = (b: DepsFixture["blockers"][number]): BlockerDto => {
      const { projectId: _p, milestoneId, ...rest } = b;
      void _p;
      return { ...rest, milestone: this.step(milestoneId) };
    };
    const mine = this.blockers.filter((b) => b.projectId === id);
    const open = mine.filter((b) => !b.resolvedOn).map(dto);
    const listed = new Set(blockedBy.map((r) => r.project.id));
    return {
      canEdit,
      blockedBy,
      blocking,
      blockers: open,
      resolved: mine.filter((b) => b.resolvedOn).sort((a, b) => b.resolvedOn!.localeCompare(a.resolvedOn!)).map(dto),
      options: canEdit ? DepsFixture.PROJECTS.filter((p) => p.id !== id && !listed.has(p.id) && p.status !== "Cancelled").map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) : [],
      milestones: canEdit ? (DepsFixture.STEPS[id] ?? []).filter((s) => !s.done).map(({ id, name }) => ({ id, name })) : [],
      people: canEdit ? DepsFixture.PEOPLE : [],
      openCount: blockedBy.length + open.length,
      today: DepsFixture.TODAY,
    };
  }

  private ok(id: string): DependencyActionResult {
    return { ok: true, view: this.view(id) };
  }

  private fail(): DependencyActionResult | null {
    return this.mode === "fail" ? { ok: false, error: DependencyCopy.SAVE_ERROR, kind: "save" } : null;
  }

  private record(kind: string, payload: unknown) {
    const w = window as unknown as { __depSaves?: unknown[] };
    (w.__depSaves ??= []).push({ kind, payload: JSON.parse(JSON.stringify(payload ?? null)) });
  }

  private blockerFields(input: BlockerInput): { error: string } | { description: string; waitingOn: string; followUpOn: string | null; followUpOwner: string | null; milestoneId: string | null } {
    const description = BlockerRules.required(input.description, BlockerRules.DESCRIPTION_MAX, "descriptionRequired", "descriptionTooLong");
    if (!description.ok) return { error: BlockerRules.MESSAGES[description.problem] };
    const waitingOn = BlockerRules.required(input.waitingOn, BlockerRules.WAITING_ON_MAX, "waitingOnRequired", "waitingOnTooLong");
    if (!waitingOn.ok) return { error: BlockerRules.MESSAGES[waitingOn.problem] };
    const date = BlockerRules.date(input.followUpOn);
    if (!date.ok) return { error: BlockerRules.MESSAGES[date.problem] };
    return { description: description.value, waitingOn: waitingOn.value, followUpOn: date.value, followUpOwner: BlockerRules.optional(input.followUpOwner), milestoneId: BlockerRules.optional(input.blockedMilestoneId) };
  }

  actions(): DependencyActions {
    const slow = async () => {
      if (new URLSearchParams(window.location.search).get("depsave") === "hold") await new Promise((r) => ((window as unknown as { __releaseDeps?: () => void }).__releaseDeps = () => r(null)));
    };
    return {
      load: async (id) => this.ok(id),
      add: async (id, by, input?: DependencyInput) => {
        this.record("add", { id, by, input });
        await slow();
        const failed = this.fail();
        if (failed) return failed;
        const problem = DependencyGraph.check(this.edges, id, by);
        if (problem) return { ok: false, error: DependencyCopy.rule(problem, this.name(by).name), kind: "rule" };
        const note = BlockerRules.note(input?.note);
        if (!note.ok) return { ok: false, error: BlockerRules.MESSAGES[note.problem], kind: "input" };
        this.edges.push({ projectId: id, blockedById: by, note: note.value, milestoneId: BlockerRules.optional(input?.blockedMilestoneId), since: DepsFixture.TODAY });
        return this.ok(id);
      },
      update: async (id, by, input) => {
        this.record("update", { id, by, input });
        const failed = this.fail();
        if (failed) return failed;
        const e = this.edges.find((x) => x.projectId === id && x.blockedById === by);
        const note = BlockerRules.note(input.note);
        if (!note.ok) return { ok: false, error: BlockerRules.MESSAGES[note.problem], kind: "input" };
        if (e) Object.assign(e, { note: note.value, milestoneId: BlockerRules.optional(input.blockedMilestoneId) });
        return this.ok(id);
      },
      remove: async (id, by, viewFor) => {
        this.record("remove", { id, by, viewFor });
        const failed = this.fail();
        if (failed) return failed;
        this.edges = this.edges.filter((e) => !(e.projectId === id && e.blockedById === by));
        return this.ok(viewFor ?? id);
      },
      addBlocker: async (id, input) => {
        this.record("addBlocker", { id, input });
        const failed = this.fail();
        if (failed) return failed;
        const f = this.blockerFields(input);
        if ("error" in f) return { ok: false, error: f.error, kind: "input" };
        this.blockers.push({ id: `blk-${++this.seq}`, projectId: id, since: DepsFixture.TODAY, resolvedOn: null, resolvedBy: null, resolution: null, ...f });
        return this.ok(id);
      },
      updateBlocker: async (id, blockerId, input) => {
        this.record("updateBlocker", { id, blockerId, input });
        const failed = this.fail();
        if (failed) return failed;
        const f = this.blockerFields(input);
        if ("error" in f) return { ok: false, error: f.error, kind: "input" };
        Object.assign(this.blockers.find((b) => b.id === blockerId)!, f);
        return this.ok(id);
      },
      resolveBlocker: async (id, blockerId, resolution) => {
        this.record("resolveBlocker", { id, blockerId, resolution });
        const failed = this.fail();
        if (failed) return failed;
        const r = BlockerRules.required(resolution, BlockerRules.RESOLUTION_MAX, "resolutionRequired", "resolutionTooLong");
        if (!r.ok) return { ok: false, error: BlockerRules.MESSAGES[r.problem], kind: "input" };
        Object.assign(this.blockers.find((b) => b.id === blockerId)!, { resolvedOn: DepsFixture.TODAY, resolvedBy: "Fictional Reviewer", resolution: r.value });
        return this.ok(id);
      },
    };
  }

  /** Read-only load for ?viewer=readonly. */
  readOnlyLoad = async (id: string): Promise<DependencyActionResult> => ({ ok: true, view: this.view(id, false) });
}
