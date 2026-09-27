import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldControlStyle, SelectControl } from "@/components/FieldControl";
import { PeopleCombobox } from "@/components/PeopleCombobox";
import { PeopleLabel } from "@/lib/domain/PeopleLabel";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();
type OwnerCell = Extract<ReturnType<typeof ReportLayout.rowLayout>["cells"][number], { kind: "owner" }>;
const cell = (r: ReportRow) =>
  ReportLayout.rowLayout(m, r, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE).cells.find((c): c is OwnerCell => c.kind === "owner")!;

describe("People labels", () => {
  it("are 'Owner:', 'Requester:' and 'Contracts:' with one normal space before the name", () => {
    expect([PeopleLabel.OWNER, PeopleLabel.REQUESTER, PeopleLabel.CONTRACTS]).toEqual(["Owner:", "Requester:", "Contracts:"]);
    expect(PeopleLabel.line("contracts", "To assign")).toBe("Contracts: To assign");
  });

  it("PDF: labels sit before the names, the owner name is fitted after its label at 600, the label is never cut", () => {
    const S = ReportGeometry.SIZE;
    const base = SampleReportData.rows()[0];
    const c = cell({ ...base, owner: "Owner D", physicianChampion: "Dr. Sample K", contractsLead: "Mellisa Gonzales" });
    expect(c.ownerLabelW).toBeCloseTo(m.width("Owner: ", S.table, 400), 5);
    expect(c.championLabelW).toBeCloseTo(m.width("Requester: ", S.small, 400), 5);
    expect(c.owner).toBe("Owner D");
    expect(c.champion).toBe("Dr. Sample K");
    expect(c.contracts?.lines).toEqual([{ prefix: "Contracts: ", text: "Mellisa Gonzales" }]);
    expect(ReportLayout.OWNER_NAME_WEIGHT).toBe(600);
    expect(ReportLayout.CONTRACTS_PREFIX_WEIGHT).toBe(400);
    const long = cell({ ...base, owner: "Bartholomew Featherstonehaugh-Worthington" });
    expect(long.owner.endsWith("\u2026")).toBe(true);
    expect(long.ownerLabelW + m.width(long.owner, S.table, 600)).toBeLessThanOrEqual(long.w + 0.01);
  });

  it("PDF: empty owner reads To assign; Not applicable still drops the requester line", () => {
    const base = SampleReportData.rows()[0];
    const c = cell({ ...base, owner: null, physicianChampion: null, requesterNotApplicable: true });
    expect(c).toMatchObject({ owner: "To assign", ownerMissing: true, champion: null });
  });

  it("PDF: sample rows keep their heights (no extra wrapping from the labels)", () => {
    const l = ReportLayout.layout(SampleReportData.docInput());
    for (const p of l.pages) for (const b of p.blocks) if (b.kind === "row") {
      const owner = b.row.cells.find((c): c is OwnerCell => c.kind === "owner")!;
      expect(owner.contracts?.lines.length ?? 0, b.row.projectId).toBeLessThanOrEqual(1);
    }
  });
});

describe("Drawer pick fields share one style", () => {
  it("selects and comboboxes use the same box classes and chevron", () => {
    const select = renderToStaticMarkup(createElement(SelectControl, { id: "s", value: "", onChange: () => {} }, createElement("option", { value: "" }, "To assign")));
    const combo = renderToStaticMarkup(
      createElement(PeopleCombobox, { role: "owner", id: "o", label: "Owner", options: ["A"], value: { kind: "unset" }, onPick: () => {} }),
    );
    for (const html of [select, combo]) {
      expect(html).toContain(FieldControlStyle.BOX);
      expect(html).toContain('d="M3 4.5 6 7.5 9 4.5"');
    }
    expect(FieldControlStyle.BOX).toContain("pl-2");
    expect(FieldControlStyle.BOX).toContain("focus:border-accent");
  });
});
