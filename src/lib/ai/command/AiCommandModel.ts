import { AiActionTools, type AiActionToolName } from "../actions/AiActionTools";

/** One turn of the command bar conversation as the browser keeps it (never stored on the server). */
export type AiCommandTurn = { role: "user" | "assistant"; text: string; proposals?: { proposalId: string; summary: string }[] };

/** One tool call the model asked for, in the JSON protocol below. */
export type AiCommandCall = { name: AiActionToolName; arguments: Record<string, unknown> };

/** The model's reply in the JSON protocol: what to say, and any tool calls to run first. */
export type AiCommandReply = { say: string; calls: AiCommandCall[] };

/**
 * Voice and command bar item: the typed command bar's pure rules. The same assistant as voice chat over the same shared
 * tools (item B), but over a text model with a provider-agnostic JSON protocol, so it works on every provider the
 * feature can route to (item D). Nothing here touches the network or the database.
 */
export class AiCommandModel {
  /** Model rounds per message: tool calls, then the answer. */
  static readonly MAX_ROUNDS = 4;
  /** Turns of history sent each time (the browser keeps the conversation). */
  static readonly MAX_TURNS = 12;
  static readonly TURN_MAX = 2000;
  static readonly MAX_TOKENS = 1600;
  /** The tools the command bar may call. draft_project is here (voice chat leaves it to the bar). */
  static readonly TOOLS = AiActionTools.ALL;

  static readonly CONTRACT = [
    "You are the command bar of a hospital project portfolio tracker. The person types requests and questions about the projects in the context below. One rough line can touch several projects. Match projects by name, REQ number, vendor, department or owner (search_projects helps).",
    "Answer questions from the context: people, milestones, history, blockers and the computed flags. Never invent people, dates or projects. If data is missing, say so (for example: No owner assigned).",
    "For any change, call propose_changes first (all the changes in one call), then say its readBack sentence and ask if you should apply it. Call apply_changes only when the person's latest message clearly says yes to that proposal, and only with that proposalId. Say a change was applied only after apply_changes returns ok with applied lines. If lines fail or are refused, say why in plain words. If they say no, apply nothing. When they say undo that, call undo_last_apply.",
    "To mark a milestone done use op complete_milestone (never rename the current milestone by setting nextMilestone). For a new project request call draft_project. Only link projects with link_projects when one really waits on the other.",
    "Do not ask for or repeat patient details. Keep answers short: one to three sentences.",
  ].join("\n");

  static readonly FORMAT =
    'Reply with one JSON object and nothing else: {"say": "what to tell the person", "calls": [{"name": "tool name", "arguments": {}}]}. Use "calls": [] when no tool is needed. When you call tools, "say" can be empty: you get the results and answer in the next round.';

  /** Compact tool descriptions for the system prompt (name, purpose, argument schema). */
  static toolsText(): string {
    return AiCommandModel.TOOLS.map((t) => `- ${t.name}: ${t.description} Arguments: ${JSON.stringify(t.parameters)}`).join("\n");
  }

  static system(context: string): string {
    return [AiCommandModel.CONTRACT, "Tools:", AiCommandModel.toolsText(), AiCommandModel.FORMAT, "Portfolio context:", context].join("\n");
  }

  /** The browser's turns, cleaned: known roles, trimmed, capped, last MAX_TURNS, ending with a user turn. Null = none. */
  static turns(raw: unknown): AiCommandTurn[] | null {
    if (!Array.isArray(raw)) return null;
    const out: AiCommandTurn[] = [];
    for (const t of raw.slice(-AiCommandModel.MAX_TURNS)) {
      const role = (t as { role?: unknown })?.role;
      const text = (t as { text?: unknown })?.text;
      if ((role !== "user" && role !== "assistant") || typeof text !== "string") continue;
      const proposals = Array.isArray((t as { proposals?: unknown }).proposals)
        ? ((t as { proposals: unknown[] }).proposals
            .map((p) => ({ proposalId: String((p as { proposalId?: unknown })?.proposalId ?? ""), summary: String((p as { summary?: unknown })?.summary ?? "").slice(0, 400) }))
            .filter((p) => /^[0-9a-f-]{36}$/i.test(p.proposalId)))
        : [];
      out.push({ role, text: text.replace(/\r\n/g, "\n").trim().slice(0, AiCommandModel.TURN_MAX), ...(proposals.length ? { proposals } : {}) });
    }
    const last = out.at(-1);
    return last && last.role === "user" && last.text ? out : null;
  }

  /** The conversation plus tool results so far, as the user message of one model call. */
  static user(turns: readonly AiCommandTurn[], results: readonly { name: string; output: string }[]): string {
    const lines = turns.map((t) => {
      const props = t.proposals?.length ? ` [proposals: ${t.proposals.map((p) => `${p.proposalId} (${p.summary})`).join("; ")}]` : "";
      return `${t.role === "user" ? "Person" : "You"}: ${t.text}${props}`;
    });
    if (results.length) lines.push("Tool results (this message):", ...results.map((r) => `${r.name} -> ${r.output.slice(0, 6000)}`));
    return lines.join("\n");
  }

  /** The model's JSON reply. Tolerates code fences and text around the object. Unknown tools are dropped. Null = unreadable. */
  static parse(text: string): AiCommandReply | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0) return text.trim() ? { say: text.trim().slice(0, 1200), calls: [] } : null;
    if (end <= start) return null;
    let body: unknown;
    try {
      body = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const b = body as { say?: unknown; calls?: unknown };
    const say = typeof b.say === "string" ? b.say.trim().slice(0, 1200) : "";
    const calls: AiCommandCall[] = [];
    for (const c of Array.isArray(b.calls) ? b.calls.slice(0, 6) : []) {
      const name = (c as { name?: unknown })?.name;
      const args = (c as { arguments?: unknown })?.arguments;
      if (!AiActionTools.isName(name)) continue;
      calls.push({ name, arguments: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} });
    }
    if (!say && !calls.length) return null;
    return { say, calls };
  }

  private static readonly YES = /^\s*(yes|yep|yeah|yup|y|ok|okay|sure|correct|confirm(ed)?|do it|go ahead|please do|sounds good|apply( it| them| that| all| both| those)?|make (it|the change|those changes))\b/i;
  private static readonly NO = /\b(no|not|don't|dont|wait|stop|cancel|hold on)\b/i;

  /** A clear yes in the person's latest message (the server-side check before apply_changes runs). */
  static isYes(text: string): boolean {
    const t = text.trim();
    if (!AiCommandModel.YES.test(t)) return false;
    // "yes but not the date" is not a clear yes to the whole proposal.
    return !AiCommandModel.NO.test(t.replace(AiCommandModel.YES, ""));
  }

  /**
   * The proposals a yes can confirm: the cards on the latest assistant turn that showed any. A yes never reaches an
   * older card, or one made during this same message that the person has not seen yet.
   */
  static offered(turns: readonly AiCommandTurn[]): Set<string> {
    for (let i = turns.length - 2; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant" && t.proposals?.length) return new Set(t.proposals.map((p) => p.proposalId.toLowerCase()));
    }
    return new Set();
  }

  static readonly NOT_OFFERED = "Not applied: that is not the proposal the person just said yes to. Only apply the proposal on your latest card.";

  static readonly NEEDS_YES = "Not applied: the person has not clearly said yes to this proposal in their latest message. Read the summary back and ask.";
}
