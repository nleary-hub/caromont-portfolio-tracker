import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };

describe("ViewSettingsService", () => {
  it("returns defaults for both contexts when no rows exist", async () => {
    const fake = new FakeDb();
    const all = await ViewSettingsService.getAll(fake.asClient());
    expect(all.dashboard).toEqual(ViewSettings.defaults("dashboard"));
    expect(all.report).toEqual(ViewSettings.defaults("report"));
  });

  it("stores contexts separately and writes one history row (who, when, old, new) per change, in one transaction", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const next = ViewSettings.withStatusHidden("dashboard", ViewSettings.defaults("dashboard"), "Complete", false);
    const saved = await ViewSettingsService.update("dashboard", next, actor, db);
    expect(saved.hiddenStatuses).toEqual(["Cancelled"]);
    expect(await ViewSettingsService.get("dashboard", db)).toEqual(next);
    expect(await ViewSettingsService.get("report", db)).toEqual(ViewSettings.defaults("report"));

    expect(fake.state.viewSettingsHistory).toHaveLength(1);
    expect(fake.state.viewSettingsHistory[0]).toMatchObject({
      context: "dashboard",
      changedBy: actor.changedBy,
      oldValue: ViewSettings.defaults("dashboard"),
      newValue: next,
    });
    expect(fake.state.viewSettingsHistory[0].changedAt).toBeInstanceOf(Date);
    expect(fake.state.viewSettings[0]).toMatchObject({ context: "dashboard", updatedBy: actor.changedBy });
    const txIds = new Set(fake.writes.map((w) => w.txId));
    expect(fake.writes.every((w) => w.inTx)).toBe(true);
    expect(txIds.size).toBe(1);
  });

  it("appends history on every change and never rewrites it", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const a = ViewSettings.withColumnHidden("report", ViewSettings.defaults("report"), "note", true);
    await ViewSettingsService.update("report", a, actor, db);
    await ViewSettingsService.reset("report", { changedBy: "someone@example.org" }, db);
    expect(fake.state.viewSettingsHistory.map((h) => [h.oldValue, h.newValue, h.changedBy])).toEqual([
      [ViewSettings.defaults("report"), a, actor.changedBy],
      [a, ViewSettings.defaults("report"), "someone@example.org"],
    ]);
    expect(fake.writes.filter((w) => w.model === "viewSettingsHistory").every((w) => w.op === "create")).toBe(true);
  });

  it("is a no-op when nothing changes (no history row)", async () => {
    const fake = new FakeDb();
    await ViewSettingsService.update("dashboard", ViewSettings.defaults("dashboard"), actor, fake.asClient());
    expect(fake.writes).toHaveLength(0);
    expect(fake.state.viewSettingsHistory).toHaveLength(0);
  });

  it("normalizes input and rejects unknown contexts", async () => {
    const fake = new FakeDb();
    const saved = await ViewSettingsService.update(
      "dashboard",
      { hiddenColumns: ["project", "flags"], hiddenStatuses: ["Complete"] },
      actor,
      fake.asClient(),
    );
    expect(saved.hiddenColumns).toEqual(["flags"]);
    await expect(ViewSettingsService.update("pdf" as never, {}, actor, fake.asClient())).rejects.toThrow();
  });
});
