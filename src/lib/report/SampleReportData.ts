import type { DepartmentKey } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { ProjectStatus } from "@/generated/prisma/enums";
import type { CompletedRow, ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import type { ReportDocInput } from "@/lib/report/pdf/ReportLayout";

type Seed = [DepartmentKey, string, ProjectStatus, string | null, string | null, string | null, boolean, ProjectStatus | null, string];

/**
 * Clearly fictional sample rows for design review renders (sample-report.pdf) and layout tests.
 * Every name is "Sample: ..." / "Owner X" / "Dr. Sample X"; no real people or projects.
 */
export class SampleReportData {
  static readonly REPORT_DATE = "2026-09-29";
  static readonly PERIOD_START = "2026-09-15";
  static readonly PERIOD_END = "2026-09-29";
  /** Fictional "Completed FY27 to date" count for sample renders. */
  static readonly FY_COMPLETED = 9;
  static readonly GENERATED_AT = new Date("2026-09-29T21:00:00Z");

  static readonly LONG_NOTE =
    "Bids came in 18% over budget; scope cut to 6 bays from 8 and rebid due 10/12. Award slips to 10/19, pushing opening to January. Need Dr. Sample B and finance to approve the revised scope by 10/9.";

  // [area, name, status, next milestone, due, note, changed, statusFrom, updatedOn]
  private static readonly SEEDS: Seed[] = [
    ["Cath", "Sample: Cath lab 3 refresh", "OnTrack", "Equipment install complete", "2026-10-21", "Vendor install scheduled for 10/14; super-user training booked the week prior. No blockers.", false, null, "2026-09-18"],
    ["Cath", "Sample: Radial lounge expansion", "AtRisk", "Construction bid awarded", "2026-09-25", "LONG", true, "OnTrack", "2026-09-24"],
    ["Cath", "Sample: Same-day discharge PCI pathway", "NotStarted", "Kickoff held", "2026-11-04", "Awaiting a requester before scheduling kickoff.", false, null, "2026-09-01"],
    ["Cath", "Sample: Hemodynamic system upgrade across all four procedure rooms and the hybrid suite", "OffTrack", "Interface validated", "2026-09-18", "Interface vendor missed two validation windows; new dates promised by 10/2. Need Dr. Sample K to approve the downtime plan drafted with nursing and biomed by 10/6.", true, "AtRisk", "2026-09-26"],
    ["EP", "Sample: EP lab mapping system upgrade", "OffTrack", "IT interface build complete", "2026-09-22", "IT interface build slipped two weeks; go-live moved to 11/3. Vendor contract was signed 9/18. Need Dr. Sample C to approve the revised workflow by 10/10.", true, "AtRisk", "2026-09-22"],
    ["EP", "Sample: Pulsed field ablation launch", "OnTrack", "First cases performed", "2026-10-28", "Credentialing complete for two operators; first cases on the 10/28 schedule.", true, null, "2026-09-23"],
    ["EP", "Sample: Device clinic remote monitoring", "OnHold", "Staffing decision made", null, "Paused pending the device clinic staffing review in October.", false, null, "2026-08-30"],
    ["EP", "Sample: Left atrial appendage program growth", "OnTrack", "Referral packet refreshed", "2026-11-12", "Referral packet drafted; review with marketing on 10/6.", false, null, "2026-09-17"],
    ["Echo", "Sample: Echo structured reporting update", "Complete", "Went live", "2026-09-15", "Went live in all reading rooms 9/15. Closing out after the 30-day review.", true, "OnTrack", "2026-09-16"],
    ["Echo", "Sample: Stress echo scheduling redesign", "AtRisk", "Template approved", "2026-10-09", "Template draft missed the 9/22 review because readers split on slot length. Need Dr. Sample E to choose 45 or 60 minutes by 10/2 to hold the 10/9 approval.", true, "NotStarted", "2026-09-25"],
    ["Echo", "Sample: Contrast echo protocol", "NotStarted", null, null, null, false, null, "2026-09-16"],
    ["CVSS", "Sample: CVSS post-op handoff checklist", "OnHold", "Pilot restarted", "2026-11-18", "Paused until unit staffing stabilizes; revisit at November ops review.", false, null, "2026-09-17"],
    ["CVSS", "Sample: ERAS pathway for valve surgery", "OnTrack", "Order set built", "2026-10-15", "Order set in build; pharmacy review booked 10/2.", true, null, "2026-09-21"],
    ["CVSS", "Sample: Surgical site infection bundle", "AtRisk", "Supplies standardized", "2026-10-01", "Two supply items on backorder; alternates under review by value analysis. Need Dr. Sample P to approve the alternates by 10/8.", true, "OnTrack", "2026-09-19"],
    ["INU", "Sample: INU bed flow redesign", "OnTrack", "Workflow signed off", "2026-10-16", "Revised flow reviewed with charge nurses; sign-off meeting set.", true, null, "2026-09-24"],
    ["INU", "Sample: Telemetry alarm reduction", "OnTrack", "Baseline data pulled", "2026-10-07", "Baseline alarm counts pulled for three units; parameters draft next.", false, null, "2026-09-18"],
    ["INU", "Sample: Discharge before noon", "OffTrack", "Unit huddles rolled out", "2026-09-20", "Huddles are live on 1 of 3 units after charge nurse turnover. New date is 10/13. Need Owner S and the INU manager to confirm huddle coverage by 10/6.", true, "OnTrack", "2026-09-25"],
    ["CardioNeuro", "Sample: Syncope clinic referral pathway", "AtRisk", "Referral criteria approved", "2026-10-14", "Criteria draft pending neurology review; may slip one cycle. Need Dr. Sample M to sign off on the criteria by 10/9.", false, null, "2026-09-16"],
    ["CardioNeuro", "Sample: Autonomic testing lab setup", "NotStarted", "Space walkthrough done", "2026-11-20", "Space options identified; walkthrough with facilities in November.", false, null, "2026-09-03"],
    ["CardioNeuro", "Sample: Stroke and AF monitoring pathway", "OnTrack", "Monitor contract signed", "2026-10-30", "Contract with the monitoring vendor in legal review.", true, null, "2026-09-22"],
    ["IR", "Sample: IR suite scheduling consolidation", "Cancelled", null, null, "Folded into the enterprise scheduling project; no further action.", true, "OnHold", "2026-09-17"],
    ["IR", "Sample: Venous access nurse program", "OnTrack", "Training cohort 2 done", "2026-10-20", "Cohort 1 signed off; cohort 2 starts 10/20.", false, null, "2026-09-17"],
    ["IR", "Sample: Peripheral vascular outpatient lab", "AtRisk", "Certificate of need filed", "2026-10-05", "Planning's market data for the certificate of need filing is two weeks late. Filing moves to 10/19 unless Dr. Sample U and strategy approve using last year's volumes by 10/2.", true, "OnTrack", "2026-09-26"],
    ["IR", "Sample: Y-90 program readiness", "OnHold", "Radiation safety review passed", "2026-12-01", "On hold for the radiation safety committee calendar.", false, null, "2026-08-28"],
    ["IR", "Sample: Dialysis access clinic", "OnTrack", "Clinic template live", "2026-10-12", "Template built; go-live after scheduler training.", false, null, "2026-09-16"],
  ];

  /** Fake Infor request numbers by seed index. The rest have none. */
  private static readonly INFOR: Readonly<Record<number, number>> = {
    0: 4656,
    1: 5081,
    3: 4702,
    4: 5012,
    9: 4981,
    12: 5104,
    15: 4870,
    19: 5033,
    22: 4999,
  };

  static rows(): ReportRow[] {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const rows = SampleReportData.SEEDS.map(([area, name, status, next, due, note, changed, from, updatedOn], i): ReportRow => {
      const overdue = ReportBuilder.isOverdue(
        { status, dueDate: due ? new Date(`${due}T00:00:00Z`) : null },
        SampleReportData.REPORT_DATE,
      );
      return {
        projectId: `sample-${i + 1}`,
        name,
        serviceArea: area,
        owner: `Owner ${letters[i % letters.length]}`,
        physicianChampion: i % 7 === 2 || i === 11 ? null : `Dr. Sample ${letters[(i * 3) % letters.length]}`,
        // One sample requester marked Not applicable (its line drops out of the owner stack).
        requesterNotApplicable: i === 11,
        status,
        statusLabel: status,
        nextMilestone: next,
        dueDate: due,
        targetCompletion: null,
        percentComplete: null,
        note: note === "LONG" ? SampleReportData.LONG_NOTE : note,
        inforRequestNumber: SampleReportData.INFOR[i] ?? null,
        // Cycles the pick-list (Mellisa Gonzales included, the longest name); every fifth row is "To assign".
        contractsLead: i % 5 === 4 ? null : ServiceLine.CVPSL_CONTRACTS_LEADS[(i + 2) % ServiceLine.CVPSL_CONTRACTS_LEADS.length],
        changed,
        overdue,
        updatedOn,
        statusFrom: from,
        stale: ReportBuilder.isStale({ status, updatedOn }, SampleReportData.REPORT_DATE),
      };
    });
    return ReportBuilder.sort(rows);
  }

  /** Fictional "Completed this period" rows (two in Cath, one in EP; one without a REQ number, owner or requester). */
  static completed(): CompletedRow[] {
    return [
      {
        projectId: "sample-done-1",
        name: "Sample: Hemodynamic system replacement",
        serviceArea: "Cath",
        owner: "Owner C",
        accomplishment:
          "New hemodynamic system live in all four procedure rooms 9/22; 212 cases recorded in the first two weeks with no downtime and every tech validated.",
        completedOn: "2026-09-22",
        completedInAppOn: "2026-09-23",
        inforRequestNumber: 4871,
        physicianChampion: "Dr. Sample K",
        contractsLead: "Mellisa Gonzales",
      },
      {
        projectId: "sample-done-2",
        name: "Sample: Vascular closure device standard",
        serviceArea: "Cath",
        owner: null,
        accomplishment: "Single closure device adopted for all femoral cases 9/17; three vendors reduced to one, with the contract in place before Q2 pricing.",
        completedOn: "2026-09-17",
        completedInAppOn: "2026-09-17",
        inforRequestNumber: null,
        physicianChampion: null,
        contractsLead: null,
      },
      {
        projectId: "sample-done-3",
        name: "Sample: Loop recorder clinic workflow",
        serviceArea: "EP",
        owner: "Owner E",
        accomplishment: "Remote transmissions now triaged within one business day.",
        completedOn: "2026-09-24",
        completedInAppOn: "2026-09-24",
        inforRequestNumber: 5120,
        physicianChampion: "Dr. Sample F",
        contractsLead: "Dave Dermady",
      },
    ];
  }

  /**
   * Sample document input with the real default report view settings (Complete and Cancelled
   * hidden). Rows include every sample project; ReportLayout lists and counts only visible statuses,
   * so passing other viewSettings in overrides shows the effect of turning a status on.
   */
  static docInput(overrides: Partial<ReportDocInput> = {}): ReportDocInput {
    const rows = SampleReportData.rows();
    const viewSettings = overrides.viewSettings ?? ViewSettings.defaults("report");
    return {
      rows,
      header: {
        ...ReportBuilder.header(rows.filter((r) => ViewSettings.isStatusVisible(viewSettings, r.status))),
        // Fictional FY-to-date count (the three completed rows plus earlier completions this fiscal year).
        completedFiscalYear: { label: FiscalYear.of(SampleReportData.REPORT_DATE).label, start: FiscalYear.of(SampleReportData.REPORT_DATE).start, count: SampleReportData.FY_COMPLETED },
      },
      viewSettings,
      reportDate: SampleReportData.REPORT_DATE,
      periodStart: SampleReportData.PERIOD_START,
      periodEnd: SampleReportData.PERIOD_END,
      generatedAt: SampleReportData.GENERATED_AT,
      exampleData: true,
      showKeyPage: true,
      completed: SampleReportData.completed(),
      serviceLine: ServiceLine.defaults(),
      ...overrides,
    };
  }
}
