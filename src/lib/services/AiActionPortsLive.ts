import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionPorts } from "@/lib/services/AiActionService";
import { ProjectDependencyService } from "@/lib/services/ProjectDependencyService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReviewService } from "@/lib/services/ReviewService";
import type { ProjectInput } from "@/lib/validation/ProjectValidator";

/**
 * Item B: the action layer's writes, each through the exact service the drawer uses for the same manual edit, with
 * the AI source tag as the history comment. Errors propagate (the layer reports them per line).
 */
export class AiActionPortsLive {
  static of(viewer: Viewer, scope: ServiceLineScope, db: PrismaClient = Db.client): AiActionPorts {
    return {
      update: async (id, patch, comment) => {
        await ProjectService.update(id, patch as Partial<ProjectInput>, { changedBy: viewer.email, comment }, db, scope);
      },
      people: async (id, field, value, comment) => {
        await ProjectService.setPeopleField(id, field, value, viewer, db, scope, comment);
      },
      saveSteps: async (id, drafts, comment) => {
        // Step owners were checked against every People list (AiActionModel); the save accepts the same names.
        const lists = await AiActionService.lists(db, scope);
        await ProjectService.saveMilestones(id, { drafts }, viewer, db, { ...scope, owners: [...lists.stepOwners] }, comment);
      },
      markReviewed: async (id) => {
        const r = await ReviewService.mark(db, viewer, scope, [id], false);
        return r.ids.includes(id) ? r.at : null;
      },
      undoReviewed: async (id, at) => (await ReviewService.undo(db, viewer, scope, [id], at)).ids.includes(id),
      addBlocker: (id, input, comment) => ProjectDependencyService.addBlocker(viewer, scope, id, input, db, new Date(), comment),
      updateBlocker: (id, blockerId, input, comment) => ProjectDependencyService.updateBlocker(viewer, scope, id, blockerId, input, db, new Date(), comment),
      resolveBlocker: (id, blockerId, resolution, comment) => ProjectDependencyService.resolveBlocker(viewer, scope, id, blockerId, resolution, db, new Date(), comment),
      addDependency: (id, blockedById, note, comment) => ProjectDependencyService.addDependency(viewer, scope, id, blockedById, { note }, db, new Date(), comment),
      removeDependency: (id, blockedById, comment) => ProjectDependencyService.removeDependency(viewer, scope, id, blockedById, db, new Date(), comment),
    };
  }
}
