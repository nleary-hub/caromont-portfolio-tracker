import { AI_ACTION_FIELDS, AI_ACTION_OPS } from "./AiActionModel";

/** Item B: the shared tool names (voice chat, the command bar and the text features all use these). */
export type AiActionToolName = "search_projects" | "get_project" | "propose_changes" | "apply_changes" | "undo_last_apply" | "draft_project" | "link_projects";

const CHANGE_ITEM = {
  type: "object",
  properties: {
    ref: { type: "string", description: "The project ref from the context, like P3." },
    op: { type: "string", enum: [...AI_ACTION_OPS], description: "set_field changes one field. Milestone ops name the milestone (blank = the current one)." },
    field: { type: "string", enum: [...AI_ACTION_FIELDS], description: "set_field only. note is the Latest update. requester is the physician champion or requesting leader." },
    value: { type: "string", description: "set_field: the new value. Dates YYYY-MM-DD. People exactly as on the line's lists; 'To assign' clears an owner." },
    milestone: { type: "string", description: "Milestone ops: the milestone name, or blank for the current milestone." },
    name: { type: "string", description: "add_milestone: the new milestone's name." },
    dueDate: { type: "string", description: "add_milestone or milestone_due: YYYY-MM-DD." },
    owner: { type: "string", description: "add_milestone or milestone_owner: a person on the line's lists." },
    after: { type: "string", description: "add_milestone or move_milestone: 'next' (becomes the current milestone, the default), 'start', 'end', or the name of the milestone it goes after." },
    blocker: { type: "string", description: "update_blocker or resolve_blocker: who or what the open blocker waits on." },
    description: { type: "string", description: "add_blocker: what is blocked (short)." },
    waitingOn: { type: "string", description: "add_blocker: the person, group or vendor it waits on." },
    followUpOn: { type: "string", description: "Blocker follow-up date, YYYY-MM-DD." },
    followUpOwner: { type: "string", description: "Who follows up (a person on the line's lists)." },
    resolution: { type: "string", description: "resolve_blocker: what resolved it." },
    other: { type: "string", description: "add_dependency or remove_dependency: the ref of the project this one is blocked by." },
    note: { type: "string", description: "add_dependency: what exactly it waits on (120 characters max)." },
    reason: { type: "string", description: "Why, in a few words, from what the person said." },
  },
  required: ["ref", "op"],
} as const;

const fn = (name: AiActionToolName, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: "function" as const, name, description, parameters: { type: "object", properties, required } });

/**
 * The function tools of the shared action layer, in the Responses/Realtime shape. Server-validated: AiActionService
 * checks every value against the stored project and the line's pick lists before anything is listed or applied.
 */
export class AiActionTools {
  static readonly SEARCH = fn("search_projects", "Find projects by name, REQ number, vendor, department or owner. Returns refs.", { query: { type: "string" }, filters: { type: "object", properties: { status: { type: "string" }, department: { type: "string" }, owner: { type: "string" }, overdue: { type: "boolean" }, blocked: { type: "boolean" } } } }, ["query"]);
  static readonly GET = fn("get_project", "Full detail of one project: people, every milestone, recent updates, blockers and flags.", { ref: { type: "string" } }, ["ref"]);
  static readonly PROPOSE = fn(
    "propose_changes",
    "Propose changes for the person to confirm. Nothing is saved yet. Returns a proposalId, the checked lines, a one-sentence summary to read back, and any refused lines with the reason.",
    { changes: { type: "array", items: CHANGE_ITEM } },
    ["changes"],
  );
  // lines is a plain integer array (no anyOf, which some realtime schemas reject); leaving it out applies every line.
  static readonly APPLY = fn("apply_changes", "Apply a proposal ONLY after the person clearly said yes to it. Leave lines out to apply every line, or list the line numbers they agreed to.", { proposalId: { type: "string" }, lines: { type: "array", items: { type: "integer" } } }, ["proposalId"]);
  static readonly UNDO = fn("undo_last_apply", "Undo the person's most recent apply (when they say undo that).", {}, []);
  static readonly DRAFT = fn(
    "draft_project",
    "Draft a new project from a request for the person to review. Creates nothing until they confirm on screen.",
    { name: { type: "string" }, description: { type: "string" }, nextMilestone: { type: "string" }, dueDate: { type: "string" }, targetCompletion: { type: "string" }, note: { type: "string" } },
    ["name"],
  );
  static readonly LINK = fn(
    "link_projects",
    "Record that project a is blocked by project b. Only for a real dependency: say what a waits on. Related-but-not-blocking projects are not saved.",
    { a: { type: "string", description: "Ref of the blocked project." }, b: { type: "string", description: "Ref of the project it waits on." }, type: { type: "string", enum: ["blocked_by", "related"] }, reason: { type: "string" } },
    ["a", "b", "type"],
  );

  static readonly ALL = [AiActionTools.SEARCH, AiActionTools.GET, AiActionTools.PROPOSE, AiActionTools.APPLY, AiActionTools.UNDO, AiActionTools.DRAFT, AiActionTools.LINK] as const;

  static isName(v: unknown): v is AiActionToolName {
    return AiActionTools.ALL.some((t) => t.name === v);
  }

  /** link_projects as a propose_changes line (only blocked_by becomes a change). */
  static linkAsChange(args: Record<string, unknown>): { ok: true; change: Record<string, unknown> } | { ok: false; why: string } {
    if (args.type !== "blocked_by") return { ok: false, why: "Related projects are not saved. Only a real Blocked-by is, with what it waits on." };
    return { ok: true, change: { ref: args.a, op: "add_dependency", other: args.b, note: args.reason, reason: args.reason } };
  }
}
