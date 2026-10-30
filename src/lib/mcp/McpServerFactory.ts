import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GateUser } from "@/lib/permissions/RoleResolver";
import { McpAppActions, MCP_APP_ACTIONS, NOT_AVAILABLE } from "@/lib/mcp/McpAppActions";
import { McpProjectTools, McpToolError, type McpToolContext, type MilestoneAction } from "@/lib/mcp/McpProjectTools";

const lineArg = z.string().optional().describe("Service line short name or id. Leave out to use your active line.");
const projectId = z.string().uuid().describe("Project id from list_projects or get_project.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** One MCP server per request (stateless Streamable HTTP), bound to the person the access token belongs to. */
export class McpServerFactory {
  static readonly INSTRUCTIONS = [
    "Service Line Portfolio: the cardiovascular service line's project tracker. Every edit is saved as the signed-in person,",
    "with the same validation and permissions as the app, and shows in the project's History as 'Claude connector'.",
    "Before changing anything, read the project with get_project so you know its current values and milestone names.",
    "Rules from the app: a project becomes Complete only when its last milestone is checked (use update_milestones), never by",
    "setting the status; the next milestone and due date come from the first open milestone; people must be on the line's lists",
    "(whoami shows them). Confirm with the person before bulk changes, and tell them exactly what you changed.",
    "Everything else the app's screens do (departments, people and access, roles, templates, service lines, settings,",
    "layout, report options, hide/delete/restore, reopen, review, dependencies, CSV import) is reached with list_app_actions",
    "then run_app_action. Actions marked needsConfirmation change or remove a lot: describe the change and get a clear yes",
    "from the person first, then pass confirmed: true.",
  ].join(" ");

  /** Said when a connection approved before admin actions existed (projects scope only) asks for one. */
  static readonly NEEDS_ADMIN_SCOPE =
    "This connection was approved for projects only. To let Claude do admin tasks too, remove the connector in Claude, add it again, and approve it on the tracker's Allow access page (it lists the admin tasks).";

  static create(viewer: GateUser, scopes: readonly string[] = ["projects"]): McpServer {
    const admin = scopes.includes("admin");
    const server = new McpServer({ name: "service-line-portfolio", version: "1.0.0" }, { instructions: McpServerFactory.INSTRUCTIONS });

    const run = async (serviceLine: string | undefined, fn: (c: McpToolContext) => Promise<unknown>): Promise<CallToolResult> => {
      try {
        const c = await McpProjectTools.context(viewer, serviceLine);
        const out = await fn(c);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        const err = e instanceof McpToolError ? e : McpProjectTools.explain(e);
        return { isError: true, content: [{ type: "text", text: err.message }] };
      }
    };

    server.registerTool(
      "whoami",
      {
        title: "Who am I",
        description: "Your account, role and what it allows, your service line(s), its departments, statuses and people lists. Call first in a session.",
        inputSchema: { serviceLine: lineArg },
        annotations: READ,
      },
      async ({ serviceLine }) => run(serviceLine, (c) => McpProjectTools.whoami(c)),
    );

    server.registerTool(
      "list_projects",
      {
        title: "List projects",
        description: "Projects in the service line (open ones by default), A to Z, with status, department, owner, next milestone, due date and overdue flag.",
        inputSchema: {
          serviceLine: lineArg,
          query: z.string().max(200).optional().describe("Text to match in name, description, owner, requester, milestone, latest update, REQ number or department."),
          status: z.array(z.string()).max(7).optional().describe("Only these statuses, e.g. ['At risk','Off track']. Includes closed statuses if listed."),
          department: z.string().optional(),
          owner: z.string().optional(),
          includeClosed: z.boolean().optional().describe("Include Complete and Cancelled projects."),
          overdueOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        annotations: READ,
      },
      async ({ serviceLine, ...args }) => run(serviceLine, (c) => McpProjectTools.listProjects(c, args)),
    );

    server.registerTool(
      "get_project",
      {
        title: "Get project",
        description: "Everything about one project: fields, people, milestones (with ids), open blockers, dependencies and the last 10 history entries.",
        inputSchema: { serviceLine: lineArg, projectId },
        annotations: READ,
      },
      async ({ serviceLine, projectId: id }) => run(serviceLine, (c) => McpProjectTools.getProject(c, id)),
    );

    server.registerTool(
      "get_project_history",
      {
        title: "Project history",
        description: "The project's change log and update notes, newest first.",
        inputSchema: { serviceLine: lineArg, projectId, limit: z.number().int().min(1).max(200).optional() },
        annotations: READ,
      },
      async ({ serviceLine, projectId: id, limit }) => run(serviceLine, (c) => McpProjectTools.projectHistory(c, id, limit)),
    );

    server.registerTool(
      "update_project",
      {
        title: "Update project",
        description:
          "Change a project's fields in one save (one History entry), like Save in the project drawer. Only send fields that change. " +
          "latestUpdate is the 'Latest update' note. Status can't be set to Complete (complete the milestones instead). " +
          "For milestones use update_milestones; for owner/requester/contracts lead use set_project_person.",
        inputSchema: {
          serviceLine: lineArg,
          projectId,
          changes: z
            .object({
              name: z.string().min(1).max(200).optional(),
              status: z.string().optional().describe("Not started, On track, At risk, Off track, On hold or Cancelled."),
              percentComplete: z.number().int().min(0).max(100).nullable().optional(),
              latestUpdate: z.string().optional(),
              accomplishment: z.string().optional(),
              description: z.string().optional(),
              inforRequestNumber: z.string().nullable().optional().describe("Digits, with or without REQ-."),
              department: z.string().nullable().optional(),
              startDate: isoDate.optional(),
              completedOn: isoDate.nullable().optional().describe("Only for a project that is already Complete."),
            })
            .strict(),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, changes }) => run(serviceLine, (c) => McpProjectTools.updateProject(c, id, changes)),
    );

    server.registerTool(
      "set_project_person",
      {
        title: "Set project person",
        description: "Set the owner, requester, contracts lead or lead role. Use a name from the line's lists (whoami). Empty clears owner/requester to 'To assign'; 'Not applicable' works for requester and contracts lead.",
        inputSchema: {
          serviceLine: lineArg,
          projectId,
          field: z.enum(["owner", "requester", "contractsLead", "leadRole"]),
          value: z.string().max(120).nullable(),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, field, value }) => run(serviceLine, (c) => McpProjectTools.setPerson(c, id, field, value)),
    );

    server.registerTool(
      "update_milestones",
      {
        title: "Update milestones",
        description:
          "Change the project's milestone checklist in one save: complete, reopen, add, rename, set_due_date, set_owner or remove. " +
          "Name milestones by their exact name or id (get_project). Completing the last open milestone completes the project. " +
          "add with position 'next' inserts before the first open milestone (it becomes the next milestone); default is the end.",
        inputSchema: {
          serviceLine: lineArg,
          projectId,
          actions: z
            .array(
              z.discriminatedUnion("action", [
                z.object({ action: z.literal("complete"), milestone: z.string() }),
                z.object({ action: z.literal("reopen"), milestone: z.string() }),
                z.object({ action: z.literal("add"), name: z.string().min(1).max(200), dueDate: isoDate.nullable().optional(), owner: z.string().nullable().optional(), position: z.enum(["next", "end"]).optional() }),
                z.object({ action: z.literal("rename"), milestone: z.string(), name: z.string().min(1).max(200) }),
                z.object({ action: z.literal("set_due_date"), milestone: z.string(), dueDate: isoDate.nullable() }),
                z.object({ action: z.literal("set_owner"), milestone: z.string(), owner: z.string().nullable() }),
                z.object({ action: z.literal("remove"), milestone: z.string() }),
              ]),
            )
            .min(1)
            .max(30),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, actions }) => run(serviceLine, (c) => McpProjectTools.updateMilestones(c, id, actions as MilestoneAction[])),
    );

    server.registerTool(
      "add_blocker",
      {
        title: "Add blocker",
        description: "Record an external blocker on a project: what is blocked and who or what it waits on, with an optional follow-up date and owner.",
        inputSchema: {
          serviceLine: lineArg,
          projectId,
          description: z.string().min(1).max(200),
          waitingOn: z.string().min(1).max(120),
          followUpOn: isoDate.optional(),
          followUpOwner: z.string().optional(),
          milestone: z.string().optional().describe("Name of the open milestone it holds up."),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, ...input }) => run(serviceLine, (c) => McpProjectTools.addBlocker(c, id, input)),
    );

    server.registerTool(
      "update_blocker",
      {
        title: "Update blocker",
        description: "Change an open blocker's description, waiting on, follow-up date or follow-up owner (blocker id from get_project).",
        inputSchema: {
          serviceLine: lineArg,
          projectId,
          blockerId: z.string().uuid(),
          description: z.string().min(1).max(200).optional(),
          waitingOn: z.string().min(1).max(120).optional(),
          followUpOn: isoDate.nullable().optional(),
          followUpOwner: z.string().nullable().optional(),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, blockerId, ...input }) => run(serviceLine, (c) => McpProjectTools.updateBlocker(c, id, blockerId, input)),
    );

    server.registerTool(
      "resolve_blocker",
      {
        title: "Resolve blocker",
        description: "Mark an open blocker resolved, with what resolved it. Blockers are kept, never deleted.",
        inputSchema: { serviceLine: lineArg, projectId, blockerId: z.string().uuid(), resolution: z.string().min(1).max(200) },
        annotations: WRITE,
      },
      async ({ serviceLine, projectId: id, blockerId, resolution }) => run(serviceLine, (c) => McpProjectTools.resolveBlocker(c, id, blockerId, resolution)),
    );

    server.registerTool(
      "create_project",
      {
        title: "Create project",
        description: "Create a project, like New project in the app. Name and department are required. Check list_projects for a duplicate first.",
        inputSchema: {
          serviceLine: lineArg,
          name: z.string().min(1).max(200),
          department: z.string(),
          description: z.string().optional(),
          latestUpdate: z.string().optional(),
          status: z.string().optional().describe("Defaults to Not started."),
          startDate: isoDate.optional().describe("Defaults to today."),
          milestones: z
            .array(z.object({ name: z.string().min(1).max(200), dueDate: isoDate.optional(), owner: z.string().optional() }))
            .max(30)
            .optional(),
        },
        annotations: WRITE,
      },
      async ({ serviceLine, ...input }) => run(serviceLine, (c) => McpProjectTools.createProject(c, input)),
    );

    server.registerTool(
      "list_app_actions",
      {
        title: "List app actions",
        description:
          "Every other thing the app's screens can do (read_* actions read an admin screen; the rest change something), with each action's input schema and whether it needs the person's confirmation. Filter by area, e.g. departments, people, roles, templates, service lines, settings, report, projects, dependencies, import, audit. Also lists what the connector deliberately can't do.",
        inputSchema: { area: z.string().optional() },
        annotations: READ,
      },
      async ({ area }) => {
        if (!admin) return { isError: true, content: [{ type: "text", text: McpServerFactory.NEEDS_ADMIN_SCOPE }] };
        const want = area?.trim().toLowerCase();
        const actions = MCP_APP_ACTIONS.filter((a) => !want || a.area === want).map((a) => ({
          name: a.name,
          area: a.area,
          kind: a.kind,
          needsConfirmation: Boolean(a.confirm),
          description: a.description,
          input: z.toJSONSchema(a.input),
        }));
        return { content: [{ type: "text", text: JSON.stringify({ areas: [...new Set(MCP_APP_ACTIONS.map((a) => a.area))], actions, notAvailable: NOT_AVAILABLE }, null, 2) }] };
      },
    );

    server.registerTool(
      "run_app_action",
      {
        title: "Run app action",
        description:
          "Run one action from list_app_actions with its input. It runs the app's own code as you, with your permissions, validation and audit history. For an action marked needsConfirmation, first tell the person exactly what will change and get a clear yes, then pass confirmed: true.",
        inputSchema: { action: z.string(), input: z.record(z.string(), z.unknown()).optional(), confirmed: z.boolean().optional() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ action, input, confirmed }) => {
        if (!admin) return { isError: true, content: [{ type: "text", text: McpServerFactory.NEEDS_ADMIN_SCOPE }] };
        const a = McpAppActions.find(action);
        if (!a) return { isError: true, content: [{ type: "text", text: `Unknown action "${action}". Call list_app_actions to see what is available.` }] };
        if (a.confirm && confirmed !== true) {
          return { isError: true, content: [{ type: "text", text: `"${a.name}" needs the person's confirmation. Describe exactly what will change, get a clear yes, then call again with confirmed: true.` }] };
        }
        const parsed = a.input.safeParse(input ?? {});
        if (!parsed.success) return { isError: true, content: [{ type: "text", text: `Input not valid for ${a.name}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "input"}: ${x.message}`).join("; ")}` }] };
        try {
          const out = await a.run(parsed.data as Record<string, unknown>);
          const failed = out && typeof out === "object" && (out as { ok?: unknown }).ok === false;
          return { ...(failed ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(out ?? { ok: true }, null, 2) }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text", text: McpAppActions.explain(e) }] };
        }
      },
    );

    return server;
  }
}
