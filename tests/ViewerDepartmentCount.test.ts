import { describe, expect, it } from "vitest";
import { ViewerDashboardModel } from "@/lib/dashboard/ViewerDashboardModel";

const row = (department: string) => ({ department });

describe("Viewer dashboard department count", () => {
  it("counts real departments only, not Unassigned", () => {
    expect(ViewerDashboardModel.departmentCount([row("Cardiology"), row("Cardiology"), row("Unassigned"), row("Imaging")])).toBe(2);
    expect(ViewerDashboardModel.departmentCount([row("Unassigned")])).toBe(0);
    expect(ViewerDashboardModel.departmentCount([])).toBe(0);
  });

  it("pluralizes the Across label", () => {
    expect(ViewerDashboardModel.acrossLabel(0)).toBe("Across 0 departments");
    expect(ViewerDashboardModel.acrossLabel(1)).toBe("Across 1 department");
    expect(ViewerDashboardModel.acrossLabel(2)).toBe("Across 2 departments");
  });

  it("labels a project with no department Unassigned", () => {
    expect(ViewerDashboardModel.UNASSIGNED).toBe("Unassigned");
  });
});
