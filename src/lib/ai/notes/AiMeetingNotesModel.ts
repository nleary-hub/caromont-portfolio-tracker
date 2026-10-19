import { AppConfig } from "@/lib/config/AppConfig";
import { CHANGE_ITEM } from "../actions/AiActionTools";

/** One note line the model could not match to a project (shown so nothing said in the meeting is lost). */
export type AiUnmatchedNote = { text: string; why: string };
export type AiMeetingNotesReply = { changes: Record<string, unknown>[]; newProjects: Record<string, unknown>[]; unmatched: AiUnmatchedNote[] };

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/**
 * Meeting notes item: Meeting notes to updates over the shared context (A) and the shared action layer (B). The model
 * turns rough notes into change lines (status, Latest update, people, milestones, blockers, Blocked-by), drafts for new
 * projects, and a list of notes it could not match. Pure: prompt, reply parsing, and merging several notes about one
 * project into one line.
 */
export class AiMeetingNotesModel {
  static readonly MAX_TOKENS = 5000;
  static readonly MAX_CHANGES = 120;
  static readonly MAX_NEW = 10;
  static readonly UPDATE_MAX = AppConfig.NOTE_DISPLAY_MAX_LENGTH;

  static system(context: string): string {
    const change = JSON.stringify(CHANGE_ITEM.properties);
    return [
      "You turn a project portfolio lead's rough meeting notes into proposed tracker changes. The person reviews every line and applies what is right; nothing is saved by you.",
      "Match each note to a project in the context by name, REQ number (\"REQ-5123\" or just \"5123\" matches the project's req), vendor (who a blocker waits on), department or owner. One note can touch several projects. Never invent people, dates or projects. People must be exactly as on the line's lists in the context; leave a person out rather than guess.",
      `Latest update (set_field note): at most ONE per project, merging everything the notes say about it. Write it in the same voice, tense and length as that project's latestUpdate and priorUpdates in the context (house style: what happened in past tense, then the next action and who owns it), under ${AiMeetingNotesModel.UPDATE_MAX} characters, with no facts that are not in the notes or the context.`,
      "Use milestone ops for milestones (complete_milestone when something is done, milestone_due, milestone_owner, add_milestone), set_field for status and people, add_blocker or resolve_blocker for outside blockers, add_dependency only for a real Blocked-by.",
      "When something is done, complete its milestone (complete_milestone), do not just say so in the Latest update. When the notes name the next step, add it with add_milestone (owner and due date only when the notes give them).",
      "If planned follow-ups from a playbook come before the notes, turn each follow-up the notes agree to into a milestone or Latest update change; skip the ones the notes do not mention.",
      "A new project mentioned in the notes goes in newProjects (it is drafted for review, never created). A note you cannot match goes in unmatched with a short reason. Never put patient details anywhere.",
      "Reply with one JSON object and nothing else:",
      `{"changes": [change objects with these fields: ${change}], "newProjects": [{"name": "...", "description": "...", "nextMilestone": "...", "dueDate": "YYYY-MM-DD", "note": "..."}], "unmatched": [{"text": "the note", "why": "..."}]}`,
      "Portfolio context:",
      context,
    ].join("\n");
  }

  /** The model's reply. Null = unreadable. */
  static parse(text: string): AiMeetingNotesReply | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const objs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, n) : []) as Record<string, unknown>[];
    const changes = AiMeetingNotesModel.merge(objs(b.changes, AiMeetingNotesModel.MAX_CHANGES));
    const newProjects = objs(b.newProjects, AiMeetingNotesModel.MAX_NEW).filter((p) => clip(p.name, 200));
    const unmatched = objs(b.unmatched, 50).flatMap((u) => (clip(u.text, 500) ? [{ text: clip(u.text, 500), why: clip(u.why, 200) || "No matching project." }] : []));
    if (!Array.isArray(b.changes) && !Array.isArray(b.newProjects) && !Array.isArray(b.unmatched)) return null;
    return { changes, newProjects, unmatched };
  }

  /**
   * Several notes about one project become one line: Latest update texts for the same project are joined (repeats
   * dropped) and, for any other set_field, the last value wins. Milestone, blocker and dependency ops pass as they are.
   */
  static merge(changes: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const fieldAt = new Map<string, number>();
    for (const c of changes) {
      const ref = typeof c.ref === "string" ? c.ref.trim().toUpperCase() : "";
      const op = c.op ?? "set_field";
      if (op !== "set_field" || typeof c.field !== "string" || !ref) {
        out.push(c);
        continue;
      }
      const key = `${ref}|${c.field}`;
      const at = fieldAt.get(key);
      if (at === undefined) {
        fieldAt.set(key, out.length);
        out.push({ ...c, op: "set_field" });
        continue;
      }
      const prev = out[at];
      if (c.field === "note") {
        const a = String(prev.value ?? "").trim();
        const b = String(c.value ?? "").trim();
        const joined = !b || a.toLowerCase().includes(b.toLowerCase()) ? a : !a || b.toLowerCase().includes(a.toLowerCase()) ? b : `${a.replace(/[.\s]*$/, ".")} ${b}`;
        out[at] = { ...prev, value: joined, reason: [prev.reason, c.reason].filter(Boolean).join("; ") };
      } else out[at] = { ...prev, value: c.value, reason: c.reason ?? prev.reason };
    }
    return out;
  }
}
