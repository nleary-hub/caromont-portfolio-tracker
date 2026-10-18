import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { CHANGE_ITEM } from "@/lib/ai/actions/AiActionTools";
import { AiRequestDraftModel } from "@/lib/ai/request/AiRequestDraftModel";

/** A project whose Latest update suggests it waits on something: why the code picked it. */
export interface AiDependencyCandidate {
  ref: string;
  projectId: string;
  name: string;
  /** The phrase found ("waiting on", "pending", ...) and/or the other project it names. */
  cues: string[];
}

/** Waiting words in a Latest update (item 8: "waiting on", "pending", "requires", "until", and close variants). */
const CUES = /\b(waiting (?:on|for)|awaiting|pending|requires?|required|until|blocked by|held up by|depends on|dependent on|on hold for)\b/gi;

/**
 * Item 8 (Related-project links folded into Dependencies): AI blocker suggestions. The code first scans the Latest
 * updates for waiting words and cross-references to other projects; the model then proposes, for those projects only,
 * Blocked-by links (add_dependency: this project waits on that one) or outside blockers (add_blocker), each with a
 * direction and a reason quoted from the update. Proposals only: they go to the shared confirm card, and a related
 * project that is not really a blocker is never proposed.
 */
export class AiDependencySuggestModel {
  static readonly MAX_TOKENS = 5000;
  static readonly MAX_CANDIDATES = 60;
  static readonly OPS = ["add_dependency", "add_blocker"] as const;

  /** The other projects a note names: the full name, or two of its name words with at least one distinctive (e.g. "Northwind" and "supply"). */
  static mentions(note: string, self: AiToolProject, projects: readonly AiToolProject[]): AiToolProject[] {
    const text = ` ${note.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
    const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const others = projects.filter((p) => p.id !== self.id);
    const full = others.filter((p) => norm(p.name) && text.includes(` ${norm(p.name)} `));
    if (full.length) return full;
    return others.filter((p) => {
      const name = norm(p.name);
      const distinct = AiRequestDraftModel.words(p.name);
      const hits = name.split(" ").filter((w) => w.length >= 4 && !/^\d+$/.test(w) && text.includes(` ${w} `));
      return new Set(hits).size >= 2 && hits.some((w) => distinct.includes(w));
    });
  }

  /** Projects worth asking about, in ref order (refs are positions in `projects`). Only `onlyId` when given. */
  static scan(projects: readonly AiToolProject[], onlyId: string | null = null): AiDependencyCandidate[] {
    const out: AiDependencyCandidate[] = [];
    projects.forEach((p, i) => {
      if (onlyId && p.id !== onlyId) return;
      const note = p.note ?? "";
      const words = [...new Set([...note.matchAll(CUES)].map((m) => m[1].toLowerCase()))];
      const named = AiDependencySuggestModel.mentions(note, p, projects).map((o) => `names ${o.name}`);
      const cues = [...words, ...named];
      if (cues.length || onlyId) out.push({ ref: `P${i + 1}`, projectId: p.id, name: p.name, cues });
    });
    return out.slice(0, AiDependencySuggestModel.MAX_CANDIDATES);
  }

  static system(context: string): string {
    const fields = JSON.stringify({ ref: CHANGE_ITEM.properties.ref, op: { type: "string", enum: AiDependencySuggestModel.OPS }, other: CHANGE_ITEM.properties.other, note: CHANGE_ITEM.properties.note, description: CHANGE_ITEM.properties.description, waitingOn: CHANGE_ITEM.properties.waitingOn, followUpOn: CHANGE_ITEM.properties.followUpOn, reason: CHANGE_ITEM.properties.reason });
    return [
      "You find real blockers in a hospital service line project portfolio. A person reviews every suggestion and applies only what is right; nothing is saved by you.",
      "You get a list of projects to check. For each one, read its latestUpdate (and priorUpdates) in the context and decide whether it is really waiting on something.",
      "- When it waits on ANOTHER PROJECT in the context, propose add_dependency with ref = the project that waits (the blocked one) and other = the project it waits on (the blocker). Get the direction right: the blocker is the one that has to finish first.",
      "- When it waits on a person, group, vendor or outside step (vendor redlines, a committee date, credentialing, an IT security review, the contracts team), propose add_blocker with description (what is blocked, short), waitingOn (who or what), and followUpOn only when the update gives a date.",
      "- Every suggestion has a reason: quote the words from the update that show the wait, in 120 characters or fewer.",
      "- Do NOT propose anything when the update only mentions another project without waiting on it (related is not blocked). Do NOT propose a blocker or Blocked-by link that the context already lists for that project.",
      "- Never invent projects, people, vendors or dates. Never put patient details anywhere.",
      "Reply with one JSON object and nothing else:",
      `{"changes": [objects with these fields: ${fields}]}`,
      "Portfolio context:",
      context,
    ].join("\n");
  }

  static user(candidates: readonly AiDependencyCandidate[]): string {
    return ["Projects to check:", ...candidates.map((c) => `${c.ref} ${c.name}${c.cues.length ? ` (found: ${c.cues.join(", ")})` : ""}`)].join("\n");
  }

  /** The proposals: add_dependency and add_blocker lines for the checked refs only. null = unreadable. */
  static parse(text: string, candidates: readonly AiDependencyCandidate[]): Record<string, unknown>[] | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let b: { changes?: unknown };
    try {
      b = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!Array.isArray(b.changes)) return null;
    const refs = new Set(candidates.map((c) => c.ref.toUpperCase()));
    return (b.changes as unknown[])
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && !Array.isArray(c))
      .filter((c) => (AiDependencySuggestModel.OPS as readonly string[]).includes(String(c.op)) && typeof c.ref === "string" && refs.has(c.ref.trim().toUpperCase()))
      .filter((c) => c.op !== "add_dependency" || (typeof c.other === "string" && c.other.trim().toUpperCase() !== String(c.ref).trim().toUpperCase()))
      .slice(0, 100);
  }
}
