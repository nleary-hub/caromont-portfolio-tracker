import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminMenu, MenuKeyboard } from "@/lib/admin/AdminMenu";
import { AdminMenuButton } from "@/components/AdminMenuButton";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";

const ADMIN = { email: "admin@example.org", isAdmin: true };
const MEMBER = { email: "member@example.org", isAdmin: false };

describe("AdminMenu.itemsFor", () => {
  it("gives admins every shipped admin route and action, in group order", () => {
    const items = AdminMenu.itemsFor(ADMIN)!;
    expect(items.map((i) => [i.group, i.label, i.href])).toEqual([
      ["work", "Import", "/admin/import"],
      ["work", "CSV template", "/admin/import/template"],
      ["work", "Export CSV", "/admin/import/export"],
      ["work", "Generate PDF", "/api/reports/preview"],
      ["work", "Reports", "/reports"],
      ["work", "Freeze and report options", "/reports#report-admin"],
      ["library", "Departments", "/admin/departments"],
      ["library", "People", "/admin/people"],
      ["admin", "Audit log", "/admin/audit"],
      ["admin", "Settings", "/#view-settings"],
      ["admin", "Service lines", "/admin/service-lines"],
      ["admin", "Report settings", "/admin/settings"],
      ["admin", "Templates", "/admin/templates"],
    ]);
    expect(items.find((i) => i.id === "generate-pdf")).toMatchObject({ kind: "action", caption: "Draft" });
  });

  it("gives non-admins and signed-out viewers nothing", () => {
    expect(AdminMenu.itemsFor(MEMBER)).toBeNull();
    expect(AdminMenu.itemsFor(null)).toBeNull();
    expect(AdminMenu.itemsFor(undefined)).toBeNull();
  });

  it("ships Departments and People in the library group, and Templates next to Report settings", () => {
    expect(AdminMenu.definitions().filter((d) => !d.shipped)).toEqual([]);
    const labels = AdminMenu.itemsFor(ADMIN)!.map((i) => i.label);
    expect(labels.indexOf("Templates")).toBe(labels.indexOf("Report settings") + 1);
    expect(labels.indexOf("People")).toBe(labels.indexOf("Departments") + 1);
    expect(labels).not.toContain("Line settings");
    expect(AdminMenu.REPORT_SETTINGS).toBe("Report settings");
  });

  it("shows the three groups in order (work, library, admin)", () => {
    expect(AdminMenu.grouped(AdminMenu.itemsFor(ADMIN)!).map((g) => g.group)).toEqual(["work", "library", "admin"]);
  });

  it("marks the current admin page only for exact plain-link matches", () => {
    const items = AdminMenu.itemsFor(ADMIN)!;
    expect(AdminMenu.currentId(items, "/admin/import")).toBe("import");
    expect(AdminMenu.currentId(items, "/admin/audit/")).toBe("audit");
    expect(AdminMenu.currentId(items, "/reports")).toBe("reports");
    expect(AdminMenu.currentId(items, "/admin/settings")).toBe("service-line");
    expect(AdminMenu.currentId(items, "/admin/service-lines")).toBe("service-lines");
    expect(AdminMenu.currentId(items, "/admin/departments")).toBe("departments");
    expect(AdminMenu.currentId(items, "/admin/people")).toBe("people");
    expect(AdminMenu.currentId(items, "/")).toBeNull();
    expect(AdminMenu.currentId(items, "/admin/import/template")).toBeNull();
    expect(AdminMenu.currentId(items, null)).toBeNull();
  });
});

describe("MenuKeyboard", () => {
  it("opens with Enter, Space and ArrowDown on the first item, ArrowUp on the last", () => {
    expect(MenuKeyboard.openFocus("Enter", 5)).toBe(0);
    expect(MenuKeyboard.openFocus(" ", 5)).toBe(0);
    expect(MenuKeyboard.openFocus("ArrowDown", 5)).toBe(0);
    expect(MenuKeyboard.openFocus("ArrowUp", 5)).toBe(4);
    expect(MenuKeyboard.openFocus("a", 5)).toBeNull();
    expect(MenuKeyboard.openFocus("Enter", 0)).toBeNull();
  });

  it("moves with arrows (wrapping), Home and End; other keys do nothing", () => {
    expect(MenuKeyboard.move(0, "ArrowDown", 3)).toBe(1);
    expect(MenuKeyboard.move(2, "ArrowDown", 3)).toBe(0);
    expect(MenuKeyboard.move(0, "ArrowUp", 3)).toBe(2);
    expect(MenuKeyboard.move(-1, "ArrowDown", 3)).toBe(0);
    expect(MenuKeyboard.move(-1, "ArrowUp", 3)).toBe(2);
    expect(MenuKeyboard.move(1, "Home", 3)).toBe(0);
    expect(MenuKeyboard.move(1, "End", 3)).toBe(2);
    expect(MenuKeyboard.move(1, "x", 3)).toBeNull();
  });
});

describe("AdminMenuSlot (server-side gate)", () => {
  it("renders the Admin button for admins", () => {
    const html = renderToStaticMarkup(createElement(AdminMenuSlot, { viewer: ADMIN }));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("Admin");
  });

  it("renders no markup at all for non-admins or no viewer", () => {
    expect(renderToStaticMarkup(createElement(AdminMenuSlot, { viewer: MEMBER }))).toBe("");
    expect(renderToStaticMarkup(createElement(AdminMenuSlot, { viewer: null }))).toBe("");
  });
});

describe("AdminMenuButton (open)", () => {
  const html = renderToStaticMarkup(createElement(AdminMenuButton, { items: AdminMenu.itemsFor(ADMIN)!, initialOpen: true }));

  it("renders every shipped item as a menuitem, with a divider between each of the three groups", () => {
    expect(html.match(/role="menuitem"/g)).toHaveLength(13);
    expect(html.match(/role="separator"/g)).toHaveLength(2);
    for (const label of ["Import", "CSV template", "Export CSV", "Generate PDF", "Reports", "Departments", "People", "Audit log", "Settings", "Service lines", "Report settings", "Templates"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('<span class="am-caption">Draft</span>');
  });

  it("never renders unshipped placeholders or disabled coming-soon items", () => {
    expect(html).not.toContain("Line settings");
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toMatch(/coming soon/i);
  });

  it("makes downloads and the draft PDF action download links", () => {
    expect(html).toMatch(/href="\/api\/reports\/preview" download=""/);
    expect(html).toMatch(/href="\/admin\/import\/template" download=""/);
  });
});
