import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import { DepartmentCopy, DepartmentRules } from "@/lib/domain/DepartmentRules";
import { DepartmentForms } from "@/lib/services/DepartmentForms";
import { DepartmentNotFoundError, DepartmentService } from "@/lib/services/DepartmentService";
import { SignedLink } from "@/lib/report/SignedLink";
import { FreezeService } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/" }));
vi.mock("@/app/actions/departments", () => ({
  archiveDepartment: async () => ({ ok: true, message: "" }),
  deleteDepartment: async () => ({ ok: true, message: "" }),
  reorderDepartments: async () => ({ ok: true, message: "" }),
  saveDepartment: async () => ({ ok: true, message: "" }),
  unarchiveDepartment: async () => ({ ok: true, message: "" }),
  addContractsLead: async () => ({ ok: true, message: "" }),
  removeContractsLead: async () => ({ ok: true, message: "" }),
}));

const ADMIN = Factory.ADMIN;
const scopeOf = (db: PrismaClient) => ServiceLineAccess.defaultLine(db);
const dept = (id: string, name: string, shortName: string, activeProjects = 0) => ({ id, name, shortName, activeProjects, updated: "Sep 26, 2026", archived: false });

describe("PR #23 review fixes", () => {
  it("Writing Bot: failure, gone and success messages (success names the department)", async () => {
    expect(DepartmentForms.FAILED).toBe("Couldn't save the change. Try again.");
    expect(DepartmentForms.GONE).toBe("That department no longer exists. Refresh the page.");
    const fake = new FakeDb();
    const db = fake.asClient();
    expect(await DepartmentForms.archive(ADMIN, "IR", db)).toEqual({ ok: true, message: "IR archived." });
    expect(await DepartmentForms.unarchive(ADMIN, "IR", db)).toEqual({ ok: true, message: "IR unarchived." });
    await DepartmentService.remove(await scopeOf(db), "CardioNeuro", { confirmName: "CardioNeuro" }, ADMIN, db);
    expect(await DepartmentForms.restore(ADMIN, "CardioNeuro", db)).toEqual({ ok: true, message: "CardioNeuro restored." });
    expect(await DepartmentForms.archive(ADMIN, "nope", db)).toEqual({ ok: false, message: "That department no longer exists. Refresh the page." });
    await expect(DepartmentService.archive(await scopeOf(db), "nope", ADMIN, db)).rejects.toThrow(DepartmentNotFoundError);
    expect([DepartmentCopy.archivedToast("Cath Lab"), DepartmentCopy.unarchivedToast("Cath Lab"), DepartmentCopy.restoredToast("Cath Lab")]).toEqual([
      "Cath Lab archived.",
      "Cath Lab unarchived.",
      "Cath Lab restored.",
    ]);
  });

  it("Figma Bro: editor preview shows the PDF heading in the name's own casing, the dashboard heading uppercase, and the grid line", async () => {
    expect(DepartmentRules.pdfHeading("Struct")).toBe("Struct");
    expect(DepartmentRules.dashboardHeading("Struct")).toBe("STRUCT");
    const { DepartmentsAdmin } = await import("@/components/DepartmentsAdmin");
    const d = dept("s1", "Structural Heart", "Struct");
    const html = renderToStaticMarkup(createElement(DepartmentsAdmin, { lineShort: "CVPSL", active: [d], archived: [], initial: { edit: "s1" } }));
    const preview = html.slice(html.indexOf('data-testid="department-preview"'));
    expect(preview).toContain("PDF heading: Struct");
    expect(preview).toContain("Dashboard heading: STRUCT");
    expect(preview).toContain("Summary grid: Struct");
    expect(preview.indexOf("PDF heading")).toBeLessThan(preview.indexOf("Dashboard heading"));
    expect(preview.indexOf("Dashboard heading")).toBeLessThan(preview.indexOf("Summary grid"));
  });

  it("Figma Bro: move-to opens empty on the placeholder and Delete stays disabled; the danger button is solid red when enabled", async () => {
    const { DepartmentsAdmin } = await import("@/components/DepartmentsAdmin");
    const html = renderToStaticMarkup(
      createElement(DepartmentsAdmin, { lineShort: "CVPSL", active: [dept("a", "Cath Lab", "Cath", 3), dept("b", "CVSS", "CVSS"), dept("c", "EP Lab", "EP")], archived: [], initial: { delete: "a" } }),
    );
    const select = html.slice(html.indexOf('data-testid="move-to"'), html.indexOf("</select>"));
    expect(select).toMatch(/<option value="" selected="">Choose a department<\/option>/);
    expect(select).not.toMatch(/value="b" selected/);
    expect(html).toMatch(/<button type="button" disabled="" class="[^"]*bg-\(--status-off-track-light-fg\)[^"]*">Delete department<\/button>/);
    expect(AdminButtonStyles.DANGER).toContain("bg-(--status-off-track-light-fg)");
    expect(AdminButtonStyles.DANGER).toContain(" text-white ");
    expect(AdminButtonStyles.DANGER).toMatch(/disabled:opacity-50/);
    // Enabled state is not dimmed: no opacity or tint outside the disabled: variants.
    expect(AdminButtonStyles.DANGER.split(" ").filter((c) => !c.startsWith("disabled:") && (c.includes("opacity") || c === "text-danger"))).toEqual([]);
  });

  it("Figma Bro: People Remove uses the same solid red danger button", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const html = renderToStaticMarkup(createElement(PeopleAdmin, { lineShort: "CVPSL", leads: [{ name: "Jeff Krause", projects: 2 }] as never, initial: { remove: "Jeff Krause" } }));
    const btn = html.match(/<button[^>]*>Remove<\/button>/)?.[0] ?? "";
    expect(btn).toContain(AdminButtonStyles.DANGER);
    expect(btn).not.toContain('disabled=""');
  });

  it("handoff.json is written once at the freeze and served as stored: a department rename afterwards changes nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ name: "Alpha", serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" } as never, { changedBy: ADMIN.email }, db);
    const opts = { trigger: "cron" as const, actor: "cron", env, now: new Date("2026-09-29T21:00:00Z"), fetch: vi.fn() };
    const r = await FreezeService.run(opts, db);
    expect(r.outcome).toBe("created");
    const stored = fake.state.artifacts.find((a) => a.kind === "handoff")!;
    const bytes = Buffer.from(stored.bytes as Uint8Array);
    expect(bytes.toString("utf8")).toContain('"Cath"');

    // Rename after the freeze (Wednesday morning).
    await DepartmentService.save(await scopeOf(db), { id: "Cath", name: "Cardiac Cath Lab", shortName: "CCL" }, ADMIN, db);
    // Later cron runs and a manual run complete nothing new and never rewrite the artifact.
    await FreezeService.run({ ...opts, now: new Date("2026-09-30T13:00:00Z") }, db);
    await FreezeService.run({ ...opts, trigger: "manual", actor: ADMIN.email, now: new Date("2026-09-30T14:00:00Z") }, db);
    expect(fake.state.artifacts.filter((a) => a.kind === "handoff")).toHaveLength(1);

    // The archive download and the signed share link serve the stored bytes.
    const archived = await ReportArchiveService.file(ADMIN, r.snapshotId!, "handoff", db, await scopeOf(db));
    expect(Buffer.from(archived!.bytes as Uint8Array).equals(bytes)).toBe(true);
    const token = SignedLink.sign(r.snapshotId!, new Date("2026-10-06T21:00:00Z"), env.SHARE_LINK_SECRET);
    const shared = await ReportArchiveService.shared(token, "handoff", db, env, new Date("2026-09-30T15:00:00Z"));
    expect(Buffer.from(shared!.bytes as Uint8Array).equals(bytes)).toBe(true);
    expect(bytes.toString("utf8")).not.toContain("CCL");
    expect(bytes.toString("utf8")).not.toContain("Cardiac Cath Lab");
  });
});
