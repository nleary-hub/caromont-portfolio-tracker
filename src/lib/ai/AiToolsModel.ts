import { AppConfig } from "@/lib/config/AppConfig";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** Project fields an AI tool may suggest a change to. Owner, physician, department and requester are never in scope. */
export type AiToolField = "status" | "nextMilestone" | "dueDate" | "targetCompletion" | "note";

/** One project as the AI sees it: a short ref (P1, P2...) instead of the database id, and only the fields it needs. */
export interface AiToolProject {
  id: string;
  name: string;
  status: string;
  nextMilestone: string | null;
  /** "YYYY-MM-DD" or null. */
  dueDate: string | null;
  targetCompletion: string | null;
  note: string | null;
}

/** One suggested change line. Nothing is applied until a person clicks Apply on that line. */
export interface AiToolChange {
  line: number;
  projectId: string;
  projectName: string;
  field: AiToolField;
  /** Current value as shown and as sent to the save ("" = blank). */
  before: string;
  after: string;
  reason: string;
}

/** Step 7: a draft new project from a pasted request. Owner, physician, requester and department stay blank. */
export interface AiProjectDraft {
  name: string;
  description: string;
  nextMilestone: string;
  dueDate: string;
  targetCompletion: string;
  note: string;
}

/** Step 8: one line of the pre-meeting brief, linked to its project. */
export interface AiBriefItem {
  projectId: string;
  projectName: string;
  text: string;
}

export interface AiBrief {
  moved: AiBriefItem[];
  stuck: AiBriefItem[];
  ask: AiBriefItem[];
}

/** Step 9: one suggested link between two projects. */
export interface AiLinkSuggestion {
  line: number;
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  reason: string;
}

/** Pure rules of the AI tools (unit tested): context building, reply parsing and value checks. */
export class AiToolsModel {
  static readonly ALL_FIELDS: readonly AiToolField[] = ["status", "nextMilestone", "dueDate", "targetCompletion", "note"];
  /** Most lines one proposal may carry. */
  static readonly MAX_LINES = 50;
  /** Most projects listed for the AI (item A: a full service line; PortfolioContext enforces the token budget). */
  static readonly MAX_PROJECTS = 500;
  /** Each project's note is cut to this many characters in the context. */
  static readonly CONTEXT_NOTE_MAX = 300;
  static readonly REASON_MAX = 200;
  static readonly NEXT_MILESTONE_MAX = 200;

  static ref(i: number): string {
    return `P${i + 1}`;
  }

  static dateText(d: Date | string | null | undefined): string | null {
    if (!d) return null;
    const x = typeof d === "string" ? new Date(d) : d;
    return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
  }

  /** The old thin project list (refs, names and a few fields). Item A replaced it in every prompt with PortfolioContext. */
  static context(projects: readonly AiToolProject[], fields: readonly AiToolField[]): string {
    return projects
      .slice(0, AiToolsModel.MAX_PROJECTS)
      .map((p, i) => {
        const o: Record<string, unknown> = { ref: AiToolsModel.ref(i), name: p.name };
        for (const f of fields) o[f] = f === "note" ? (p.note ?? "").slice(0, AiToolsModel.CONTEXT_NOTE_MAX) : p[f];
        return JSON.stringify(o);
      })
      .join("\n");
  }

  static current(p: AiToolProject, field: AiToolField): string {
    const v = p[field];
    return v === null || v === undefined ? "" : String(v);
  }

  /** "On hold", "on_hold", "OnHold" and "ONHOLD" all become OnHold. null when it isn't a status. */
  static status(v: string): string | null {
    const key = v.replace(/[\s_-]/g, "").toLowerCase();
    return ProjectStatusInfo.all().find((s) => s.toLowerCase() === key) ?? null;
  }

  static validDate(v: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }

  /** The value as it will be saved, or null when it isn't valid for the field. "" clears a date or text field. */
  static clean(field: AiToolField, raw: unknown): string | null {
    if (typeof raw !== "string" && raw !== null) return null;
    const v = (raw ?? "").trim();
    switch (field) {
      case "status":
        return AiToolsModel.status(v);
      case "dueDate":
      case "targetCompletion":
        return v === "" || AiToolsModel.validDate(v) ? v : null;
      case "nextMilestone":
        return v.length <= AiToolsModel.NEXT_MILESTONE_MAX ? v : null;
      case "note":
        return v.length <= AppConfig.NOTE_MAX_LENGTH ? v : null;
    }
  }

  /** The first JSON object in a reply (models sometimes wrap it in a code fence). */
  static json(text: string): unknown {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  /**
   * Parses {"changes":[{"ref","field","value","reason"}]} into checked lines. Unknown refs, fields outside `fields`,
   * invalid values, no-op changes and repeats of the same project and field are dropped. null = unreadable reply.
   */
  static parseChanges(text: string, projects: readonly AiToolProject[], fields: readonly AiToolField[]): AiToolChange[] | null {
    const body = AiToolsModel.json(text) as { changes?: unknown } | null;
    if (!body || !Array.isArray(body.changes)) return null;
    const out: AiToolChange[] = [];
    const seen = new Set<string>();
    for (const c of body.changes as Record<string, unknown>[]) {
      if (out.length >= AiToolsModel.MAX_LINES) break;
      if (!c || typeof c !== "object") continue;
      const m = typeof c.ref === "string" ? /^P(\d+)$/i.exec(c.ref.trim()) : null;
      const p = m ? projects[Number(m[1]) - 1] : undefined;
      const field = fields.find((f) => f === c.field);
      if (!p || !field) continue;
      const after = AiToolsModel.clean(field, c.value as unknown);
      const before = AiToolsModel.current(p, field);
      if (after === null || after === before) continue;
      const key = `${p.id}:${field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = typeof c.reason === "string" ? c.reason.trim().slice(0, AiToolsModel.REASON_MAX) : "";
      out.push({ line: out.length, projectId: p.id, projectName: p.name, field, before, after, reason });
    }
    return out;
  }

  /** Keeps the lines of the first project only, renumbered (Quick capture is about one project). */
  static oneProject(changes: readonly AiToolChange[]): AiToolChange[] {
    const first = changes[0]?.projectId;
    return changes.filter((c) => c.projectId === first).map((c, i) => ({ ...c, line: i }));
  }

  static readonly DRAFT_NAME_MAX = 200;

  /** Checks a draft (the AI's or the edited one). null when the name is missing or any value is invalid. */
  static cleanDraft(raw: unknown): AiProjectDraft | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : o[k] === undefined || o[k] === null ? "" : null);
    const d = { name: str("name"), description: str("description"), nextMilestone: str("nextMilestone"), dueDate: str("dueDate"), targetCompletion: str("targetCompletion"), note: str("note") };
    if (Object.values(d).some((v) => v === null)) return null;
    const v = d as AiProjectDraft;
    if (!v.name || v.name.length > AiToolsModel.DRAFT_NAME_MAX || v.description.length > AppConfig.DESCRIPTION_MAX_LENGTH) return null;
    if (v.nextMilestone.length > AiToolsModel.NEXT_MILESTONE_MAX || v.note.length > AppConfig.NOTE_MAX_LENGTH) return null;
    if ((v.dueDate && !AiToolsModel.validDate(v.dueDate)) || (v.targetCompletion && !AiToolsModel.validDate(v.targetCompletion))) return null;
    return v;
  }

  static parseDraft(text: string): AiProjectDraft | null {
    const body = AiToolsModel.json(text) as { project?: unknown } | null;
    return body ? AiToolsModel.cleanDraft(body.project) : null;
  }

  /** The new project as the normal create receives it: Not started, nothing assigned. */
  static draftInput(d: AiProjectDraft): Record<string, string | null> {
    return { name: d.name, description: d.description || null, status: "NotStarted", nextMilestone: d.nextMilestone || null, dueDate: d.dueDate || null, targetCompletion: d.targetCompletion || null, note: d.note || null };
  }

  static readonly BRIEF_ITEMS_MAX = 8;
  static readonly BRIEF_TEXT_MAX = 300;

  /** Step 8: reads the brief. Items with an unknown ref or no text are dropped. null = unreadable. */
  static parseBrief(text: string, projects: readonly AiToolProject[]): AiBrief | null {
    const body = AiToolsModel.json(text) as Record<string, unknown> | null;
    if (!body) return null;
    const list = (k: string): AiBriefItem[] =>
      (Array.isArray(body[k]) ? (body[k] as Record<string, unknown>[]) : [])
        .map((i) => {
          const m = i && typeof i.ref === "string" ? /^P(\d+)$/i.exec(i.ref.trim()) : null;
          const p = m ? projects[Number(m[1]) - 1] : undefined;
          const t = i && typeof i.text === "string" ? i.text.trim().slice(0, AiToolsModel.BRIEF_TEXT_MAX) : "";
          return p && t ? { projectId: p.id, projectName: p.name, text: t } : null;
        })
        .filter((x): x is AiBriefItem => x !== null)
        .slice(0, AiToolsModel.BRIEF_ITEMS_MAX);
    return { moved: list("moved"), stuck: list("stuck"), ask: list("ask") };
  }

  static readonly LINKS_MAX = 20;

  /** A pair in stored order (smaller id first), so A to B and B to A are the same link. */
  static pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  /** Step 9: reads suggested links. Unknown refs, self links, repeats and already-linked pairs are dropped. */
  static parseLinks(text: string, projects: readonly AiToolProject[], existing: ReadonlySet<string>): AiLinkSuggestion[] | null {
    const body = AiToolsModel.json(text) as { links?: unknown } | null;
    if (!body || !Array.isArray(body.links)) return null;
    const at = (ref: unknown) => {
      const m = typeof ref === "string" ? /^P(\d+)$/i.exec(ref.trim()) : null;
      return m ? projects[Number(m[1]) - 1] : undefined;
    };
    const seen = new Set(existing);
    const out: AiLinkSuggestion[] = [];
    for (const l of body.links as Record<string, unknown>[]) {
      if (out.length >= AiToolsModel.LINKS_MAX) break;
      const a = at(l?.a);
      const b = at(l?.b);
      if (!a || !b || a.id === b.id) continue;
      const key = AiToolsModel.pairKey(a.id, b.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = typeof l.reason === "string" ? l.reason.trim().slice(0, AiToolsModel.REASON_MAX) : "";
      out.push({ line: out.length, aId: a.id, aName: a.name, bId: b.id, bName: b.name, reason });
    }
    return out;
  }

  /** The patch the normal project save receives for one applied line. */
  static patch(field: AiToolField, value: string): Record<string, string | null> {
    return { [field]: value === "" ? null : value };
  }
}
