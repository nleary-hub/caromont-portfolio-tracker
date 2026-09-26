import { describe, expect, it } from "vitest";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { Factory } from "./helpers/factories";

describe("ChampionCheck.findMissing", () => {
  it("matches by email when the champion has one (case-insensitive)", () => {
    const projects = [Factory.project({ physicianChampion: "Dr. B", physicianChampionEmail: "DrB@Example.org" })];
    expect(ChampionCheck.findMissing(projects, [Factory.recipient({ name: "Someone Else", email: "drb@example.org" })])).toEqual([]);
    // Name matches but email does not: still missing (email takes precedence).
    const missing = ChampionCheck.findMissing(projects, [Factory.recipient({ name: "Dr. B", email: "other@example.org" })]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ name: "Dr. B", email: "drb@example.org" });
  });

  it("matches by case-insensitive name when no email", () => {
    const projects = [Factory.project({ physicianChampion: "  dr.   sample  a " })];
    expect(ChampionCheck.findMissing(projects, [Factory.recipient({ name: "Dr. Sample A" })])).toEqual([]);
    expect(ChampionCheck.findMissing(projects, [Factory.recipient({ name: "Dr. Sample Z" })])).toHaveLength(1);
  });

  it("ignores inactive recipients", () => {
    const projects = [Factory.project({ physicianChampion: "Dr. A" })];
    expect(ChampionCheck.findMissing(projects, [Factory.recipient({ name: "Dr. A", active: false })])).toHaveLength(1);
  });

  it("only considers active projects (not archived, not Complete/Cancelled), regardless of includeInReport", () => {
    const projects = [
      Factory.project({ id: "arch", physicianChampion: "Dr. Arch", archivedAt: new Date() }),
      Factory.project({ id: "done", physicianChampion: "Dr. Done", status: "Complete" }),
      Factory.project({ id: "canc", physicianChampion: "Dr. Canc", status: "Cancelled" }),
      Factory.project({ id: "hidden", physicianChampion: "Dr. Hidden", includeInReport: false }),
      Factory.project({ id: "none", physicianChampion: null }),
    ];
    const missing = ChampionCheck.findMissing(projects, []);
    expect(missing.map((m) => m.name)).toEqual(["Dr. Hidden"]);
  });

  it("groups multiple projects per champion and sorts by name", () => {
    const projects = [
      Factory.project({ id: "1", name: "P1", physicianChampion: "Dr. Zed" }),
      Factory.project({ id: "2", name: "P2", physicianChampion: "dr. zed" }),
      Factory.project({ id: "3", name: "P3", physicianChampion: "Dr. Amy", physicianChampionEmail: "amy@x.org" }),
    ];
    const missing = ChampionCheck.findMissing(projects, []);
    expect(missing.map((m) => m.name)).toEqual(["Dr. Amy", "Dr. Zed"]);
    expect(missing[1].projectIds).toEqual(["1", "2"]);
    expect(missing[1].projectNames).toEqual(["P1", "P2"]);
  });

  it("never mutates the recipient list", () => {
    const recipients = [Factory.recipient()];
    const before = JSON.stringify(recipients);
    ChampionCheck.findMissing([Factory.project({ physicianChampion: "Dr. New" })], recipients);
    expect(JSON.stringify(recipients)).toBe(before);
  });
});
