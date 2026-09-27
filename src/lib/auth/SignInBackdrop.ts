import type { ProjectStatus } from "@/generated/prisma/enums";

export interface BackdropRow {
  id: string;
  name: string;
  status: ProjectStatus;
  /** Progress bar fill, 0 to 1. */
  progress: number;
  flag: "changed" | "overdue" | null;
}

export interface BackdropMetric {
  label: string;
  value: number;
}

/**
 * The animated portfolio wall behind /signin. Decorative only and shown before anyone signs in, so every row and
 * number here is made up: never feed it real projects or counts. Deterministic (no randomness while rendering) so
 * the server and browser render the same markup.
 */
export class SignInBackdrop {
  static readonly STATEMENT = ["Every project.", "One view."] as const;

  static readonly METRICS: readonly BackdropMetric[] = [
    { label: "Active", value: 42 },
    { label: "On track", value: 31 },
    { label: "Reports sent", value: 26 },
  ];

  static readonly STATUSES: readonly ProjectStatus[] = ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Complete", "Cancelled"];

  static readonly COLUMNS = 6;
  static readonly ROWS_PER_COLUMN = 8;
  /** One scroll loop per column, in seconds: different speeds give the parallax. */
  static readonly COLUMN_SPEEDS_S = [34, 26, 40, 30, 22, 36] as const;

  private static readonly NAMES = [
    "TAVR pathway redesign",
    "Cath lab throughput",
    "EP ablation scheduling",
    "Structural heart clinic",
    "Heart failure readmit",
    "Device clinic remote",
    "Chest pain unit SLA",
    "Cardiac rehab intake",
    "ECG order set update",
    "Afib bundle rollout",
    "Valve referral tracker",
    "Cardiogenic shock team",
    "Echo turnaround time",
    "LVAD workflow",
    "Coronary CTA program",
    "Pericarditis pathway",
    "Telemetry bed audit",
    "PCI door-to-balloon",
    "Lipid clinic launch",
    "Syncope eval protocol",
  ];

  static column(index: number): BackdropRow[] {
    return Array.from({ length: SignInBackdrop.ROWS_PER_COLUMN }, (_, k) => SignInBackdrop.row(index * 3 + k, `${index}-${k}`));
  }

  static columns(): BackdropRow[][] {
    return Array.from({ length: SignInBackdrop.COLUMNS }, (_, i) => SignInBackdrop.column(i));
  }

  private static row(i: number, id: string): BackdropRow {
    return {
      id,
      name: SignInBackdrop.NAMES[i % SignInBackdrop.NAMES.length],
      status: SignInBackdrop.STATUSES[(i * 3) % SignInBackdrop.STATUSES.length],
      progress: (35 + ((i * 37) % 60)) / 100,
      flag: i % 4 === 0 ? "changed" : i % 5 === 0 ? "overdue" : null,
    };
  }
}
