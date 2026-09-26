import type { ProjectStatus } from "@/generated/prisma/enums";

/** One vector primitive on a 10 x 10 grid, drawn in the pill text color. */
export type ShapePart =
  | { kind: "circle"; cx: number; cy: number; r: number; fill: boolean; strokeWidth?: number }
  | { kind: "path"; d: string; fill: boolean; strokeWidth?: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number };

/**
 * Status shapes (design: portfolio-tracker-mockups/status-shapes.html, shapes.py). Each status has a
 * distinct silhouette so status never depends on color alone. Used by the dashboard pills and the PDF.
 */
export class StatusShapes {
  static readonly VIEWBOX = 10;

  private static readonly PARTS: Record<ProjectStatus, readonly ShapePart[]> = {
    NotStarted: [{ kind: "circle", cx: 5, cy: 5, r: 3.6, fill: false, strokeWidth: 1.4 }],
    OnTrack: [{ kind: "circle", cx: 5, cy: 5, r: 4.2, fill: true }],
    AtRisk: [{ kind: "path", d: "M5 .8L9.4 9H.6z", fill: true }],
    OffTrack: [{ kind: "path", d: "M5 .4L9.6 5 5 9.6.4 5z", fill: true }],
    OnHold: [
      { kind: "rect", x: 1.5, y: 1, width: 2.4, height: 8, rx: 0.6 },
      { kind: "rect", x: 6.1, y: 1, width: 2.4, height: 8, rx: 0.6 },
    ],
    Complete: [{ kind: "path", d: "M1.2 5.2l2.6 2.6L8.8 2.2", fill: false, strokeWidth: 1.8 }],
    Cancelled: [{ kind: "path", d: "M2 2l6 6M8 2l-6 6", fill: false, strokeWidth: 1.8 }],
  };

  /** Changed flag diamond (same silhouette as Off track, drawn smaller inside the flag). */
  static readonly DIAMOND: readonly ShapePart[] = StatusShapes.PARTS.OffTrack;

  static parts(status: ProjectStatus): readonly ShapePart[] {
    return StatusShapes.PARTS[status];
  }
}
