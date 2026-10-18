import { AiToolsModel, type AiToolField, type AiToolProject } from "./AiToolsModel";
import { AiToolsCopy } from "./AiToolsCopy";
import { AiActionTools } from "./actions/AiActionTools";

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
  /** Item C: the first tool voice uses for a change (the shared layer's propose_changes). */
  static readonly TOOL_NAME = AiActionTools.PROPOSE.name;
  /** The step 10 review-only tool, kept for the old propose path (proposeAiVoiceEdits). No longer sent to the model. */
  static readonly LEGACY_TOOL_NAME = "suggest_project_changes";
  static readonly VOICE = "alloy";

  /**
   * Item C: the tools voice chat sends (Realtime in the browser, Live through the Responses backend). Every call runs
   * on the server through the shared action layer (runAiActionTool). draft_project stays with the command bar.
   */
  static readonly TOOLS = [AiActionTools.PROPOSE, AiActionTools.APPLY, AiActionTools.UNDO, AiActionTools.SEARCH, AiActionTools.GET, AiActionTools.LINK] as const;

  static readonly TOOL = {
    type: "function",
    name: AiVoiceChat.LEGACY_TOOL_NAME,
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

  /** Admin voice chat instructions are capped here (validated on the server). */
  static readonly INSTRUCTIONS_MAX = 4000;
  /** Always sent, whatever the admin instructions say. */
  static readonly TOOL_CONTRACT =
    "For any change, first call propose_changes. Then say its readBack sentence and ask if you should apply it. Call apply_changes only after the person clearly says yes, and only with that proposalId. Say a change was applied only after apply_changes returns ok with applied lines, and then say what was applied. If it returns failed or refused lines, say why in plain words. If they say no, apply nothing. When they say undo that, call undo_last_apply. Use search_projects or get_project when you need more detail about a project.";
  static readonly PATIENT_LINE = "Do not ask for or repeat patient details.";
  static readonly BUILT_IN_RULES: readonly string[] = [
    "You are a voice assistant for a hospital project portfolio. Answer short questions about the projects listed below, in plain spoken English.",
    "Only use the projects listed. If asked about anything else, say you can only see these projects.",
  ];

  /**
   * The session instructions, the same for the Live and Realtime adapters. The rules are the admin's voice chat
   * instructions when set (Admin > AI settings), otherwise the built-in rules. The tool contract, the patient-details
   * line and the projects the viewer can see (refs, names, fields) are always added.
   */
  static instructions(projects: readonly AiToolProject[] | string, custom: string | null = null): string {
    const rules = custom?.trim() ? [custom.trim().slice(0, AiVoiceChat.INSTRUCTIONS_MAX)] : AiVoiceChat.BUILT_IN_RULES;
    // Item A: the service passes the shared portfolio context (PortfolioContext text); a list is the old thin form.
    if (typeof projects === "string") return [...rules, AiVoiceChat.TOOL_CONTRACT, AiVoiceChat.PATIENT_LINE, "Portfolio context:", projects].join("\n");
    return [...rules, AiVoiceChat.TOOL_CONTRACT, AiVoiceChat.PATIENT_LINE, "Projects (one JSON object per line):", AiToolsModel.context(projects, AiVoiceChat.FIELDS)].join("\n");
  }

  /**
   * The Live (gpt-live-*) voice prompt: the same instructions plus one line, because on the Live API the tools
   * run in the Responses backend (which gets the same instructions), so the voice model delegates change requests.
   */
  static liveInstructions(base: string): string {
    return `${base}\nFor changes, delegate the request to the backend, which calls propose_changes and, after the person says yes, apply_changes.`;
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

/** Browser-side voice chat failures: which message to show and which code to report for the log. */
export class AiVoiceErrors {
  /** getUserMedia failed: permission blocked vs no microphone at all. */
  static mic(e: unknown): { code: "mic_denied" | "no_mic"; message: string } {
    const name = (e as { name?: unknown })?.name;
    return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? { code: "mic_denied", message: AiToolsCopy.VOICE_MIC_DENIED } : { code: "no_mic", message: AiToolsCopy.VOICE_NO_MIC };
  }

  /** The WebRTC handshake failed after the session started: the key can't use the model, or the connection itself. */
  static connect(e: unknown): { code: "model_unavailable" | "connect_failed"; message: string; status: number | null; type: string | null; detail: string | null } {
    const info = (e as { info?: { status?: number; type?: string; code?: string; message?: string; modelUnavailable?: boolean } })?.info ?? {};
    const unavailable = info.modelUnavailable === true;
    return { code: unavailable ? "model_unavailable" : "connect_failed", message: unavailable ? AiToolsCopy.VOICE_MODEL_UNAVAILABLE : AiToolsCopy.VOICE_CONNECT_FAILED, status: typeof info.status === "number" ? info.status : null, type: info.type ?? info.code ?? (e as Error)?.name ?? null, detail: info.message ?? null };
  }

  /** ICE failed, or dropped before any media flowed: shown as the network message and logged as ice_failed. */
  static ice(state: string): { code: "ice_failed"; message: string; type: string } {
    return { code: "ice_failed", message: AiToolsCopy.VOICE_ICE_FAILED, type: state };
  }
}
