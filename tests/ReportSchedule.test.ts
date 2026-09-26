import { describe, expect, it } from "vitest";
import { ReportSchedule } from "@/lib/report/ReportSchedule";

describe("ReportSchedule (biweekly, anchored Tue 2026-09-29 5 PM ET)", () => {
  it("knows the freeze dates", () => {
    expect(ReportSchedule.isFreezeDate("2026-09-29")).toBe(true);
    expect(ReportSchedule.isFreezeDate("2026-10-13")).toBe(true);
    expect(ReportSchedule.isFreezeDate("2026-10-27")).toBe(true);
    expect(ReportSchedule.isFreezeDate("2026-10-06")).toBe(false);
    expect(ReportSchedule.isFreezeDate("2026-09-15")).toBe(false); // before the anchor
    expect(ReportSchedule.isFreezeDate("2027-01-05")).toBe(true);
  });

  it("periods run from the previous freeze date to the freeze date", () => {
    expect(ReportSchedule.periodFor("2026-09-29")).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-09-29" });
    expect(ReportSchedule.periodFor("2026-10-13")).toEqual({ periodStart: "2026-09-29", periodEnd: "2026-10-13" });
    expect(() => ReportSchedule.periodFor("2026-10-14")).toThrow();
  });

  it("a freeze becomes due at 5 PM ET (EDT: 21:00 UTC)", () => {
    expect(ReportSchedule.dueFreezeDate(new Date("2026-09-29T20:59:00Z"))).toBeNull(); // 4:59 PM EDT
    expect(ReportSchedule.dueFreezeDate(new Date("2026-09-29T21:00:00Z"))).toBe("2026-09-29"); // 5:00 PM EDT
    expect(ReportSchedule.dueFreezeDate(new Date("2026-10-06T21:30:00Z"))).toBe("2026-09-29"); // off week
    expect(ReportSchedule.dueFreezeDate(new Date("2026-10-13T20:30:00Z"))).toBe("2026-09-29"); // 4:30 PM
    expect(ReportSchedule.dueFreezeDate(new Date("2026-10-13T21:05:00Z"))).toBe("2026-10-13");
  });

  it("after the switch to EST the 21:00 UTC run is 4 PM and the 22:00 UTC run freezes", () => {
    // 2026-11-10 is a freeze date; EST (UTC-5) from 2026-11-01.
    expect(ReportSchedule.isFreezeDate("2026-11-10")).toBe(true);
    expect(ReportSchedule.dueFreezeDate(new Date("2026-11-10T21:10:00Z"))).toBe("2026-10-27");
    expect(ReportSchedule.dueFreezeDate(new Date("2026-11-10T22:10:00Z"))).toBe("2026-11-10");
  });

  it("names the next freeze and the period a draft would belong to", () => {
    expect(ReportSchedule.nextFreezeOnOrAfter("2026-09-26")).toBe("2026-09-29");
    expect(ReportSchedule.nextFreezeOnOrAfter("2026-09-30")).toBe("2026-10-13");
    expect(ReportSchedule.upcomingPeriod(new Date("2026-09-26T12:00:00Z")).periodEnd).toBe("2026-09-29");
    expect(ReportSchedule.upcomingPeriod(new Date("2026-09-29T22:00:00Z")).periodEnd).toBe("2026-10-13");
  });
});
