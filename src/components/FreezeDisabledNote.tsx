/**
 * Preview deployments (FreezeGuard): the muted note next to a disabled Freeze now or Check Drive button, so the Report
 * freeze card reads as one state. FREEZE_DISABLED_BUTTON is the shared disabled look of both buttons.
 */
export const FREEZE_DISABLED_BUTTON = "disabled:opacity-60 disabled:text-fg";

export function FreezeDisabledNote({ note, testId }: { note: string; testId: string }) {
  return (
    <span data-testid={testId} className="type-caption text-muted">
      {note}
    </span>
  );
}
