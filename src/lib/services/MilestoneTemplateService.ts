import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";

type Reader = Pick<Prisma.TransactionClient, "milestoneTemplate" | "milestoneTemplateItem">;
type Tx = Prisma.TransactionClient;

export interface TemplateItemDto {
  id: string;
  name: string;
  position: number;
}

export interface TemplateDto {
  id: string;
  name: string;
  position: number;
  items: TemplateItemDto[];
}

export interface TemplateChange {
  templateId: string | null;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: Date;
  changedBy: string;
}

export class TemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export class TemplateNotFoundError extends Error {
  constructor() {
    super("Template not found");
    this.name = "TemplateNotFoundError";
  }
}

/**
 * The only read/write path for milestone templates. Every write is admin-only (checked here) and appends
 * a milestone_template_history row (old value, new value, who, when) in the same transaction. Templates are
 * copied into a project when applied, so editing or deleting one never changes any project.
 */
export class MilestoneTemplateService {
  static readonly ACTIONS = {
    created: "template_created",
    renamed: "template_renamed",
    deleted: "template_deleted",
    reordered: "templates_reordered",
    itemAdded: "item_added",
    itemRenamed: "item_renamed",
    itemDeleted: "item_deleted",
    itemsReordered: "items_reordered",
  } as const;

  /** All templates in order, each with its steps in order. */
  static async list(db: Reader = Db.client): Promise<TemplateDto[]> {
    const [templates, items] = await Promise.all([db.milestoneTemplate.findMany({}), db.milestoneTemplateItem.findMany({})]);
    return [...templates]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((t) => ({
        id: t.id,
        name: t.name,
        position: t.position,
        items: items
          .filter((i) => i.templateId === t.id)
          .sort((a, b) => a.position - b.position)
          .map((i) => ({ id: i.id, name: i.name, position: i.position })),
      }));
  }

  /** list() for pages that must render without the table (migration 0015 not applied): empty then. */
  static async listOrEmpty(db: Reader = Db.client): Promise<TemplateDto[]> {
    try {
      return await MilestoneTemplateService.list(db);
    } catch (e) {
      console.error("Could not read milestone templates", e);
      return [];
    }
  }

  static async create(name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<TemplateDto> {
    AdminPolicy.assertAdmin(admin);
    const clean = MilestoneTemplateService.templateName(name);
    return db.$transaction(async (tx) => {
      const all = await tx.milestoneTemplate.findMany({ select: { position: true } });
      const position = all.reduce((m, t) => Math.max(m, t.position), 0) + 1;
      const t = await tx.milestoneTemplate.create({ data: { name: clean, position, updatedBy: admin.email } });
      await MilestoneTemplateService.audit(tx, admin, t.id, MilestoneTemplateService.ACTIONS.created, null, { name: clean });
      return { id: t.id, name: t.name, position: t.position, items: [] };
    });
  }

  static async rename(id: string, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    const clean = MilestoneTemplateService.templateName(name);
    await db.$transaction(async (tx) => {
      const t = await MilestoneTemplateService.load(tx, id);
      if (t.name === clean) return;
      await tx.milestoneTemplate.update({ where: { id }, data: { name: clean, updatedBy: admin.email } });
      await MilestoneTemplateService.audit(tx, admin, id, MilestoneTemplateService.ACTIONS.renamed, { name: t.name }, { name: clean });
    });
  }

  /** Delete a template and its steps. Projects that used it keep their steps (sourceTemplateId becomes null). */
  static async remove(id: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const t = await MilestoneTemplateService.load(tx, id);
      const items = await MilestoneTemplateService.items(tx, id);
      await tx.milestoneTemplate.delete({ where: { id } });
      await MilestoneTemplateService.audit(tx, admin, id, MilestoneTemplateService.ACTIONS.deleted, { name: t.name, items: items.map((i) => i.name) }, null);
    });
  }

  static async reorder(ids: readonly string[], admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const all = [...(await tx.milestoneTemplate.findMany({}))].sort((a, b) => a.position - b.position);
      MilestoneTemplateService.assertSameSet(all.map((t) => t.id), ids);
      if (all.map((t) => t.id).join("|") === ids.join("|")) return;
      for (const [i, id] of ids.entries()) await tx.milestoneTemplate.update({ where: { id }, data: { position: i + 1, updatedBy: admin.email } });
      const nameOf = new Map(all.map((t) => [t.id, t.name]));
      await MilestoneTemplateService.audit(tx, admin, null, MilestoneTemplateService.ACTIONS.reordered, all.map((t) => t.name), ids.map((id) => nameOf.get(id)));
    });
  }

  static async addItem(templateId: string, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<TemplateItemDto> {
    AdminPolicy.assertAdmin(admin);
    const clean = MilestoneTemplateService.itemName(name);
    return db.$transaction(async (tx) => {
      await MilestoneTemplateService.load(tx, templateId);
      const items = await MilestoneTemplateService.items(tx, templateId);
      if (items.length >= MilestoneRules.MAX_STEPS) throw new TemplateValidationError(`At most ${MilestoneRules.MAX_STEPS} steps`);
      const position = items.reduce((m, i) => Math.max(m, i.position), 0) + 1;
      const item = await tx.milestoneTemplateItem.create({ data: { templateId, name: clean, position } });
      await MilestoneTemplateService.touch(tx, templateId, admin);
      await MilestoneTemplateService.audit(tx, admin, templateId, MilestoneTemplateService.ACTIONS.itemAdded, null, { name: clean, position });
      return { id: item.id, name: item.name, position: item.position };
    });
  }

  static async renameItem(itemId: string, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    const clean = MilestoneTemplateService.itemName(name);
    await db.$transaction(async (tx) => {
      const item = await MilestoneTemplateService.loadItem(tx, itemId);
      if (item.name === clean) return;
      await tx.milestoneTemplateItem.update({ where: { id: itemId }, data: { name: clean } });
      await MilestoneTemplateService.touch(tx, item.templateId, admin);
      await MilestoneTemplateService.audit(tx, admin, item.templateId, MilestoneTemplateService.ACTIONS.itemRenamed, { name: item.name }, { name: clean });
    });
  }

  static async removeItem(itemId: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const item = await MilestoneTemplateService.loadItem(tx, itemId);
      await tx.milestoneTemplateItem.delete({ where: { id: itemId } });
      const rest = await MilestoneTemplateService.items(tx, item.templateId);
      for (const [i, r] of rest.entries()) if (r.position !== i + 1) await tx.milestoneTemplateItem.update({ where: { id: r.id }, data: { position: i + 1 } });
      await MilestoneTemplateService.touch(tx, item.templateId, admin);
      await MilestoneTemplateService.audit(tx, admin, item.templateId, MilestoneTemplateService.ACTIONS.itemDeleted, { name: item.name, position: item.position }, null);
    });
  }

  static async reorderItems(templateId: string, itemIds: readonly string[], admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      await MilestoneTemplateService.load(tx, templateId);
      const items = await MilestoneTemplateService.items(tx, templateId);
      MilestoneTemplateService.assertSameSet(items.map((i) => i.id), itemIds);
      if (items.map((i) => i.id).join("|") === itemIds.join("|")) return;
      for (const [i, id] of itemIds.entries()) await tx.milestoneTemplateItem.update({ where: { id }, data: { position: i + 1 } });
      const nameOf = new Map(items.map((i) => [i.id, i.name]));
      await MilestoneTemplateService.touch(tx, templateId, admin);
      await MilestoneTemplateService.audit(tx, admin, templateId, MilestoneTemplateService.ACTIONS.itemsReordered, items.map((i) => i.name), itemIds.map((id) => nameOf.get(id)));
    });
  }

  /** Recent template changes, newest first (admin only). */
  static async history(admin: Viewer, limit = 20, db: Pick<Prisma.TransactionClient, "milestoneTemplateHistory"> = Db.client): Promise<TemplateChange[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.milestoneTemplateHistory.findMany({ orderBy: { changedAt: "desc" }, take: limit });
    return rows.map((r) => ({ templateId: r.templateId, action: r.action, oldValue: r.oldValue, newValue: r.newValue, changedAt: r.changedAt, changedBy: r.changedBy }));
  }

  static templateName(name: unknown): string {
    const clean = MilestoneRules.clean(name);
    const err = MilestoneRules.nameError(clean, MilestoneRules.TEMPLATE_NAME_MAX);
    if (err) throw new TemplateValidationError(`Template name: ${err}`);
    return clean;
  }

  static itemName(name: unknown): string {
    const clean = MilestoneRules.clean(name);
    const err = MilestoneRules.nameError(clean);
    if (err) throw new TemplateValidationError(`Step name: ${err}`);
    return clean;
  }

  private static async load(tx: Tx, id: string) {
    const t = await tx.milestoneTemplate.findUnique({ where: { id } });
    if (!t) throw new TemplateNotFoundError();
    return t;
  }

  private static async loadItem(tx: Tx, id: string) {
    const item = await tx.milestoneTemplateItem.findUnique({ where: { id } });
    if (!item) throw new TemplateNotFoundError();
    return item;
  }

  private static async items(tx: Tx, templateId: string) {
    return [...(await tx.milestoneTemplateItem.findMany({ where: { templateId } }))].sort((a, b) => a.position - b.position);
  }

  private static async touch(tx: Tx, id: string, admin: Viewer): Promise<void> {
    await tx.milestoneTemplate.update({ where: { id }, data: { updatedBy: admin.email } });
  }

  private static assertSameSet(current: readonly string[], next: readonly string[]): void {
    const a = [...current].sort().join("|");
    const b = [...next].sort().join("|");
    if (a !== b || new Set(next).size !== next.length) throw new TemplateValidationError("The list changed; reload and try again");
  }

  private static async audit(tx: Tx, admin: Viewer, templateId: string | null, action: string, oldValue: unknown, newValue: unknown): Promise<void> {
    await tx.milestoneTemplateHistory.create({
      data: {
        templateId,
        action,
        oldValue: (oldValue ?? undefined) as Prisma.InputJsonValue | undefined,
        newValue: (newValue ?? undefined) as Prisma.InputJsonValue | undefined,
        changedBy: admin.email,
      },
    });
  }
}
