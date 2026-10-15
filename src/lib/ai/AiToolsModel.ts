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

/** Pure rules of the AI tools (unit tested): context building, reply parsing and value checks. */
export class AiToolsModel {
  static readonly ALL_FIELDS: readonly AiToolField[] = ["status", "nextMilestone", "dueDate", "targetCompletion", "note"];
  /** Most lines one proposal may carry. */
  static readonly MAX_LINES = 50;
  /** Most projects sent as context. */
  static readonly MAX_PROJECTS = 200;
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

  /** The project list sent to the model: refs, names and the allowed fields only. */
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

  /** The patch the normal project save receives for one applied line. */
  static patch(field: AiToolField, value: string): Record<string, string | null> {
    return { [field]: value === "" ? null : value };
  }
}
