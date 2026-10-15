import { AiToolsModel, type AiToolField, type AiToolProject } from "./AiToolsModel";

type Price = number | string | { toString(): string } | null | undefined;

/**
 * Step 10: voice chat. The pieces that don't touch the network or the database: the session instructions, the one
 * tool the model may call, turning that call into review lines, and the usage cost. Example data only in tests.
 */
export class AiVoiceChat {
  /** The fields voice chat may suggest changes to (all of the review layer's fields; nothing saves without Apply). */
  static readonly FIELDS: readonly AiToolField[] = AiToolsModel.ALL_FIELDS;
  /** One conversation is capped here (the browser hangs up; the server bills no more than this). */
  static readonly MAX_SESSION_S = 15 * 60;
  static readonly TOOL_NAME = "suggest_project_changes";
  static readonly VOICE = "alloy";

  static readonly TOOL = {
    type: "function",
    name: AiVoiceChat.TOOL_NAME,
    description: "Suggest changes to projects for the person to review. Nothing is saved until they apply each line on screen.",
    parameters: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "The project ref from the list, like P3." },
              name: { type: "string", description: "The project name exactly as listed." },
              field: { type: "string", enum: [...AiToolsModel.ALL_FIELDS] },
              value: { type: "string", description: "New value. Dates as YYYY-MM-DD. Empty clears the field." },
              reason: { type: "string" },
            },
            required: ["ref", "name", "field", "value"],
          },
        },
      },
      required: ["changes"],
    },
  } as const;

  /** The session instructions: the projects the viewer can see (refs, names, fields) and the rules. */
  static instructions(projects: readonly AiToolProject[]): string {
    return [
      "You are a voice assistant for a hospital project portfolio. Answer short questions about the projects listed below, in plain spoken English.",
      "Only use the projects listed. If asked about anything else, say you can only see these projects.",
      "Never claim to have saved or changed anything. When the person asks for a change, call suggest_project_changes; the change is then listed on screen for them to apply or reject.",
      "Do not ask for or repeat patient details.",
      "Projects (one JSON object per line):",
      AiToolsModel.context(projects, AiVoiceChat.FIELDS),
    ].join("\n");
  }

  /**
   * The tool call's arguments as review lines. A line is kept only when its ref and name both point at the same
   * project the viewer can see now (so a renamed or reordered list can't redirect an edit). null = unreadable.
   */
  static parseToolArgs(args: unknown, projects: readonly AiToolProject[]) {
    let body: unknown = args;
    if (typeof args === "string") {
      try {
        body = JSON.parse(args);
      } catch {
        return null;
      }
    }
    const raw = (body as { changes?: unknown })?.changes;
    if (!Array.isArray(raw)) return null;
    const matched = raw.filter((c: Record<string, unknown>) => {
      const m = c && typeof c.ref === "string" ? /^P(\d+)$/i.exec(c.ref.trim()) : null;
      const p = m ? projects[Number(m[1]) - 1] : undefined;
      return !!p && typeof c.name === "string" && c.name.trim().toLowerCase() === p.name.trim().toLowerCase();
    });
    return AiToolsModel.parseChanges(JSON.stringify({ changes: matched }), projects, AiVoiceChat.FIELDS);
  }

  /** Whole seconds between start and end, never below 0 or above the cap. */
  static seconds(startedAt: Date, endedAt: Date): number {
    const s = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    return Math.max(0, Math.min(AiVoiceChat.MAX_SESSION_S, Number.isFinite(s) ? s : 0));
  }

  /**
   * Cost in USD from the admin-entered price (Admin > AI settings, step 3b). Only a per-minute price can be applied to
   * a duration; anything else (no price, a per-token price) is null, so the log never shows a guessed cost.
   */
  static cost(seconds: number, unit: string | null | undefined, inputPrice: Price): number | null {
    if (unit !== "per_minute" || inputPrice === null || inputPrice === undefined) return null;
    const per = Number(String(inputPrice));
    if (!Number.isFinite(per) || per < 0) return null;
    return Math.round((seconds / 60) * per * 1_000_000) / 1_000_000;
  }
}
