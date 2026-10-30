import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import type { Metadata } from "next";
import Link from "next/link";
import { Permissions } from "@/lib/permissions/Permissions";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { TemplatesEditor } from "@/components/TemplatesEditor";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import type { AiModelDb } from "@/lib/services/AiModelService";
import type { AiSettingsDb } from "@/lib/services/AiSettingsService";
import { MilestoneTemplateService, type TemplateChange } from "@/lib/services/MilestoneTemplateService";

// CTO, Oct 29, 2026: 85 s on anything that waits on a model reply. This page hosts AI generation server actions, which
// inherit its limit. The gateway budget (45 s main + 35 s fallback = 80 s) fits inside it.
export const maxDuration = 85;

export const metadata: Metadata = { title: "Milestone templates" };

class TemplateAuditFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

  static readonly ACTION_LABELS: Readonly<Record<string, string>> = {
    template_created: "Template created",
    template_renamed: "Template renamed",
    template_deleted: "Template deleted",
    templates_reordered: "Templates reordered",
    item_added: "Step added",
    item_renamed: "Step renamed",
    item_deleted: "Step deleted",
    items_reordered: "Steps reordered",
  };

  static when(d: Date): string {
    return `${TemplateAuditFormat.WHEN.format(d)} ET`;
  }

  /** Short, readable form of a stored value (a name, a list of names, or a name plus steps). */
  static value(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") {
      // Template AI rows carry applyId and source; a list or text value is under "value".
      const o = v as { name?: unknown; items?: unknown; value?: unknown };
      if ("value" in o) return TemplateAuditFormat.value(o.value);
      const items = Array.isArray(o.items) ? ` (${o.items.length} steps)` : "";
      return `${typeof o.name === "string" ? o.name : ""}${items}`;
    }
    return String(v);
  }

  static action(c: TemplateChange): string {
    return TemplateAuditFormat.ACTION_LABELS[c.action] ?? c.action;
  }
}

/** The Template AI button state: undefined = hidden (feature or AI off), null = ready, a note = paused. */
async function templateAiNote(): Promise<string | null | undefined> {
  try {
    const note = (await AiToolsReadiness.notes(Db.client as unknown as AiModelDb & AiSettingsDb, ["template_ai"])).template_ai ?? null;
    return note === AiToolsCopy.FEATURE_OFF_NOTE || note === AiToolsCopy.AI_OFF_NOTE ? undefined : note;
  } catch {
    return undefined;
  }
}

/** Admin-only milestone templates. Non-admins get a 404 so the route is not revealed. */
export default async function AdminTemplatesPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer || !Permissions.can(viewer, "admin.templates")) notFound();
  const configured = Db.isConfigured();
  // Templates of the admin's active service line.
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const templates = configured ? await MilestoneTemplateService.listOrEmpty(undefined, scope) : [];
  // Template AI: hidden when the feature or AI is off; paused with the model-off note when no model is on.
  const aiNote = configured && OwnerPolicy.isOwner(viewer) ? await templateAiNote() : undefined;
  const history = configured ? await MilestoneTemplateService.history(viewer, 20, undefined, scope).catch(() => []) : [];

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLineSlot viewer={viewer} active={scope} />
          <div className="h-6 w-px bg-line" />
          <h1 className="type-title whitespace-nowrap">Milestone templates</h1>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      {!configured && <p className="text-danger type-caption">DATABASE_URL is not configured.</p>}

      <TemplatesEditor key={scope.id} initial={templates} aiNote={aiNote} readOnly={!configured} />

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Recent changes</h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full type-table">
            <thead className="bg-card text-left text-muted type-label">
              <tr>
                {["When", "Who", "Change", "Old", "New"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted">
                    No changes yet.
                  </td>
                </tr>
              )}
              {history.map((h, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{TemplateAuditFormat.when(h.changedAt)}</td>
                  <td className="px-3 py-2">{h.changedBy}</td>
                  <td className="px-3 py-2">{TemplateAuditFormat.action(h)}</td>
                  <td className="px-3 py-2 text-muted">{TemplateAuditFormat.value(h.oldValue)}</td>
                  <td className="px-3 py-2">{TemplateAuditFormat.value(h.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
