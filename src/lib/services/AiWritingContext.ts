import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";

type Scope = Pick<ServiceLineScope, "id" | "departmentLimit">;

/**
 * Item 9: the writing assistant's project facts. The shared context (item A) for one project: identity, people,
 * status, milestones, change tracking, blockers, the current Latest update and the last 3 prior updates with dates.
 * Read only. Fails soft: no project (New project form), a project out of scope, or a read error gives null, and the
 * assistant then works on the text alone exactly as before.
 */
export class AiWritingContext {
  static async load(args: { db: unknown; scope: Scope; viewer: Viewer; projectId: string | null; now?: () => Date }): Promise<string | null> {
    if (!args.projectId) return null;
    const d = args.db as { project?: { findMany?: unknown } };
    if (typeof d.project?.findMany !== "function") return null;
    try {
      // Loaded on demand: AiToolsService imports AiWritingService, which uses this module.
      const { AiToolsService } = await import("./AiToolsService");
      const db = args.db as Parameters<typeof AiToolsService.projects>[0];
      // The callers pass the active line from ServiceLineAccess (a full scope); the type here is the writing layer's.
      const scope = args.scope as ServiceLineScope;
      const projects = await AiToolsService.projects(db, scope, args.projectId);
      if (projects.length !== 1) return null;
      const text = await AiToolsService.contextFor(db, scope, args.viewer, projects, args.now);
      return text.trim() ? text : null;
    } catch (e) {
      console.error("AI writing assistant: project facts not loaded", (e as Error)?.name);
      return null;
    }
  }
}
