import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import type { PermissionKey } from "@/lib/permissions/PermissionKeys";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";

/**
 * - link: normal navigation.
 * - download: a file download (CSV template or export); rendered as <a download>.
 * - action: a one-click action with a right-side caption (Generate PDF, caption "Draft").
 * - viewSettings: opens the Dashboard view picker (on "/" directly, elsewhere via "/#view-settings").
 */
export type AdminMenuItemKind = "link" | "download" | "action" | "viewSettings";

export type AdminMenuIcon = "upload" | "file" | "download" | "pdf" | "archive" | "snowflake" | "template" | "people" | "audit" | "settings" | "tag" | "departments" | "reportSettings" | "sparkle";

/** Display groups, in order, separated by dividers. */
export type AdminMenuGroup = "work" | "library" | "admin";

export interface AdminMenuItem {
  id: string;
  label: string;
  kind: AdminMenuItemKind;
  icon: AdminMenuIcon;
  href: string;
  group: AdminMenuGroup;
  /** Right-side caption (e.g. "Draft"). */
  caption?: string;
}

interface AdminMenuDefinition extends AdminMenuItem {
  /** Items that are not built yet stay defined here but are not rendered until this is true. */
  shipped: boolean;
}

/**
 * The admin menu in the top bar: every admin route and action in one place.
 * `itemsFor` returns null for anyone who is not an admin, so callers render no markup at all.
 * Admin is decided on the server by `AdminPolicy` (via `CurrentViewer`); each target route or action
 * re-checks admin itself (the menu is convenience, not security).
 */
export class AdminMenu {
  static readonly VIEW_SETTINGS_HASH = "#view-settings";
  /** Window event the dashboard picker listens for (fired when the menu is used on "/"). */
  static readonly OPEN_VIEW_SETTINGS_EVENT = "admin-menu:open-view-settings";
  static readonly GROUPS: readonly AdminMenuGroup[] = ["work", "library", "admin"];
  /** Menu item, page heading and metadata title of /admin/settings (was "Line settings"). */
  static readonly DASHBOARD_VIEW = "Dashboard view";
  static readonly REPORT_CONTENTS = "Report contents";
  static readonly REPORT_FREEZE = "Report freeze";
  /** Menu item, page heading and metadata title of /admin/ai (AiCopy.MENU_LABEL). */
  static readonly AI_SETTINGS = "AI settings";

  private static readonly DEFINITIONS: readonly AdminMenuDefinition[] = [
    // Group 1: day-to-day work.
    { id: "import", group: "work", kind: "link", icon: "upload", label: "Import", href: "/admin/import", shipped: true },
    { id: "csv-template", group: "work", kind: "download", icon: "file", label: "CSV template", href: "/admin/import/template", shipped: true },
    { id: "csv-export", group: "work", kind: "download", icon: "download", label: "Export CSV", href: "/admin/import/export", shipped: true },
    { id: "generate-pdf", group: "work", kind: "action", icon: "pdf", label: "Generate PDF", caption: "Draft", href: "/api/reports/preview", shipped: true },
    { id: "reports", group: "work", kind: "link", icon: "archive", label: "Reports", href: "/reports", shipped: true },
    { id: "freeze", group: "work", kind: "link", icon: "snowflake", label: AdminMenu.REPORT_FREEZE, href: "/reports#report-admin", shipped: true },
    // Report contents of the active line (departments in report, totals grid), right after the freeze options.
    // Departments and contracts leads have their own pages (Departments, People).
    { id: "service-line", group: "work", kind: "link", icon: "reportSettings", label: AdminMenu.REPORT_CONTENTS, href: "/admin/settings", shipped: true },
    // Group 2: the active line's lists.
    { id: "departments", group: "library", kind: "link", icon: "departments", label: "Departments", href: "/admin/departments", shipped: true },
    { id: "people", group: "library", kind: "link", icon: "people", label: "People", href: "/admin/people", shipped: true },
    // Group 3: oversight and settings.
    { id: "audit", group: "admin", kind: "link", icon: "audit", label: "Audit log", href: "/admin/audit", shipped: true },
    // Read-only list of Blocked-by dependencies for review (no edit or delete).
    { id: "dependencies", group: "admin", kind: "link", icon: "audit", label: "Dependencies review", href: "/admin/dependencies", shipped: true },
    { id: "settings", group: "admin", kind: "viewSettings", icon: "settings", label: AdminMenu.DASHBOARD_VIEW, href: `/${AdminMenu.VIEW_SETTINGS_HASH}`, shipped: true },
    { id: "service-lines", group: "admin", kind: "link", icon: "tag", label: "Service lines", href: "/admin/service-lines", shipped: true },
    // Milestone templates.
    { id: "templates", group: "admin", kind: "link", icon: "template", label: "Templates", href: "/admin/templates", shipped: true },
    // AI tools hub: a secondary spot (the tools themselves sit where people work on the dashboard). Route unchanged.
    { id: "ai-tools", group: "admin", kind: "link", icon: "sparkle", label: "AI tools", href: "/ai-tools", shipped: true },
    // Writing assistant: provider, model and API key (off by default).
    { id: "ai-settings", group: "admin", kind: "link", icon: "sparkle", label: AdminMenu.AI_SETTINGS, href: "/admin/ai", shipped: true },
  ];

  /** Menu items only the Owner sees (OwnerPolicy): AI, and the report freeze (Owner-only, invisible to others). */
  static readonly OWNER_ONLY: readonly string[] = ["ai-tools", "ai-settings", "freeze"];

  /** Every defined item, shipped or not (for tests and docs). */
  static definitions(): readonly (AdminMenuItem & { shipped: boolean })[] {
    return AdminMenu.DEFINITIONS;
  }

  /** The permission key behind each non-Owner item (Roles & Permissions). */
  static readonly KEYS: Readonly<Record<string, PermissionKey>> = {
    import: "admin.import",
    "csv-template": "admin.import",
    "csv-export": "admin.export",
    "generate-pdf": "report.pdf.onDemand",
    reports: "report.view",
    "service-line": "admin.settings",
    departments: "admin.departments",
    people: "people.view",
    audit: "admin.audit",
    dependencies: "project.review",
    settings: "admin.layout",
    "service-lines": "admin.serviceLines",
    templates: "admin.templates",
  };

  /** Items everyone with Reports access has; the menu shows only when the viewer has something beyond these. */
  private static readonly BASIC: readonly string[] = ["generate-pdf", "reports"];

  /** Shipped items the viewer's keys allow; null when there is no admin work for them (render nothing). */
  static itemsFor(viewer: PermissionUser | null | undefined): AdminMenuItem[] | null {
    if (!viewer) return null;
    // Owner-only items (AI, report freeze) are invisible to everyone else.
    const owner = OwnerPolicy.isOwner(viewer);
    const items = AdminMenu.DEFINITIONS.filter((d) => {
      if (!d.shipped) return false;
      if (AdminMenu.OWNER_ONLY.includes(d.id)) return owner;
      const key = AdminMenu.KEYS[d.id];
      return key !== undefined && Permissions.can(viewer, key);
    });
    if (!items.some((d) => !AdminMenu.BASIC.includes(d.id))) return null;
    return items.map((d) => AdminMenu.toItem(d));
  }

  private static toItem(d: AdminMenuDefinition): AdminMenuItem {
    const item: AdminMenuItem = { id: d.id, label: d.label, kind: d.kind, icon: d.icon, href: d.href, group: d.group };
    if (d.caption) item.caption = d.caption;
    return item;
  }

  /** Non-empty groups in display order (an empty group gets no section and no divider). */
  static grouped(items: readonly AdminMenuItem[]): { group: AdminMenuGroup; items: AdminMenuItem[] }[] {
    return AdminMenu.GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group) })).filter(
      (g) => g.items.length > 0,
    );
  }

  /**
   * The item for the current admin page, if any: a plain link whose path equals the pathname.
   * Items with a hash (Freeze, Settings) and downloads/actions are never "current".
   */
  static currentId(items: readonly AdminMenuItem[], pathname: string | null | undefined): string | null {
    if (!pathname) return null;
    const path = pathname.replace(/\/+$/, "") || "/";
    const hit = items.find((i) => i.kind === "link" && !i.href.includes("#") && i.href === path);
    return hit?.id ?? null;
  }
}

/** Roving focus for the menu (WAI-ARIA menu button pattern). Pure so it can be unit tested. */
export class MenuKeyboard {
  /** Index to focus after `key` inside an open menu of `count` items, or null when the key does not move focus. */
  static move(current: number, key: string, count: number): number | null {
    if (count <= 0) return null;
    switch (key) {
      case "ArrowDown":
        return current < 0 ? 0 : (current + 1) % count;
      case "ArrowUp":
        return current < 0 ? count - 1 : (current - 1 + count) % count;
      case "Home":
        return 0;
      case "End":
        return count - 1;
      default:
        return null;
    }
  }

  /** Which item gets focus when a key opens the menu from the button; null = the key does not open it. */
  static openFocus(key: string, count: number): number | null {
    if (count <= 0) return null;
    if (key === "Enter" || key === " " || key === "ArrowDown") return 0;
    if (key === "ArrowUp") return count - 1;
    return null;
  }
}
