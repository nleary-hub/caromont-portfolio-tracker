import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Codex review on PR #112 (Oct 30, 2026): two connector report actions could say "saved" when nothing was saved.
// The e2e suite covers both against a real database; these pin the same behavior in the fast suite.

const saveReportOptions = vi.fn();
const update = vi.fn();
const activeFor = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/auth", () => ({ auth: async () => null, signIn: async () => undefined, signOut: async () => undefined, SIGN_IN_PATH: "/signin" }));
vi.mock("@/app/actions/reports", () => ({ saveReportOptions: (...a: unknown[]) => saveReportOptions(...a), saveReportColors: vi.fn(), setShowKeyPageForm: vi.fn() }));
vi.mock("@/lib/services/ReportOptionsService", () => ({ ReportOptionsService: { update: (...a: unknown[]) => update(...a) } }));
vi.mock("@/lib/access/ServiceLineAccess", () => ({ ServiceLineAccess: { activeFor: (...a: unknown[]) => activeFor(...a), activeOrDefault: (...a: unknown[]) => activeFor(...a) } }));

const { ActingViewer } = await import("@/lib/auth/ActingViewer");
const { McpAppActions, McpAppActionError } = await import("@/lib/mcp/McpAppActions");

const OWNER = { email: "owner@example.org", name: "Owner", isAdmin: true } as never;
const OTHER_ADMIN = { email: "admin@example.org", name: "Admin", isAdmin: true } as never;
const SCOPE = { id: "line-1", isDefault: true, departments: [] };

const runAs = (viewer: never, action: string, input: Record<string, unknown>) => ActingViewer.run(viewer, () => McpAppActions.find(action)!.run(input));

describe("connector report actions report only what was saved", () => {
  beforeEach(() => {
    vi.stubEnv("OWNER_EMAIL", "owner@example.org");
    saveReportOptions.mockReset().mockResolvedValue({ ok: true, message: "Saved.", value: {} });
    update.mockReset();
    activeFor.mockReset().mockResolvedValue(SCOPE);
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("save_report_options: the Waiting-on setting", () => {
    const sentForm = () => saveReportOptions.mock.calls.at(-1)![1] as FormData;

    it("showWaitingOn false sends the marker without the checkbox, so off is saved", async () => {
      await runAs(OWNER, "save_report_options", { departments: ["EP"], totalsGrid: "top", showWaitingOn: false });
      expect(sentForm().get("waitingOnField")).not.toBeNull();
      expect(sentForm().get("showWaitingOn")).toBeNull();
    });

    it("showWaitingOn true sends the marker and a checked box", async () => {
      await runAs(OWNER, "save_report_options", { departments: ["EP"], totalsGrid: "top", showWaitingOn: true });
      expect(sentForm().get("waitingOnField")).not.toBeNull();
      expect(sentForm().get("showWaitingOn")).toBe("on");
    });

    it("leaving showWaitingOn out sends no marker, so the setting is left as it is", async () => {
      await runAs(OWNER, "save_report_options", { departments: ["EP"], totalsGrid: "top" });
      expect(sentForm().get("waitingOnField")).toBeNull();
    });

    it("no longer accepts the internal marker as input", () => {
      expect(Object.keys(McpAppActions.find("save_report_options")!.input.shape)).not.toContain("waitingOnField");
    });

    it("passes the form's own refusal through (ok: false), so the connector reports the failure", async () => {
      saveReportOptions.mockResolvedValue({ ok: false, message: "Could not save the change." });
      await expect(runAs(OWNER, "save_report_options", { departments: ["EP"], totalsGrid: "top", showWaitingOn: false })).resolves.toEqual({ ok: false, message: "Could not save the change." });
    });
  });

  describe("set_report_key_page", () => {
    it("returns the stored values after a save", async () => {
      update.mockResolvedValue({ showKeyPage: false, totalsGrid: "lastPage" });
      await expect(runAs(OWNER, "set_report_key_page", { showKeyPage: false, totalsGrid: "lastPage" })).resolves.toEqual({ ok: true, showKeyPage: false, totalsGrid: "lastPage" });
      expect(update).toHaveBeenCalledWith({ showKeyPage: false, totalsGrid: "lastPage" }, OWNER, undefined, SCOPE);
    });

    it("refuses anyone but the Owner and saves nothing", async () => {
      await expect(runAs(OTHER_ADMIN, "set_report_key_page", { showKeyPage: false, totalsGrid: "top" })).rejects.toBeInstanceOf(McpAppActionError);
      expect(update).not.toHaveBeenCalled();
    });

    it("lets a database failure through instead of answering ok", async () => {
      update.mockRejectedValue(new Error("db down"));
      await expect(runAs(OWNER, "set_report_key_page", { showKeyPage: false, totalsGrid: "top" })).rejects.toThrow("db down");
    });

    it("no longer calls the Server Function that returns nothing and swallows errors", async () => {
      const reports = await import("@/app/actions/reports");
      update.mockResolvedValue({ showKeyPage: true, totalsGrid: "top" });
      await runAs(OWNER, "set_report_key_page", { showKeyPage: true, totalsGrid: "top" });
      expect(reports.setShowKeyPageForm).not.toHaveBeenCalled();
    });
  });
});
