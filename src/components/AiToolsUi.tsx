/**
 * Shared look of the AI tools page buttons and model-off note (design review r2).
 *
 * TOOL_PRIMARY: the primary fill without .btn-primary, so a disabled, paused or unfocused button has no blue glow (the
 * same fix as Add model in #57). The glow shows only on an enabled button with keyboard focus. Paused (model off) uses
 * aria-disabled, like Draft and Fit in 3b-2: greyed, still focusable, tied to the note with aria-describedby.
 */
const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GLOW =
  "[&:enabled:not([aria-disabled=true]):focus-visible]:shadow-[inset_0_0_0_1px_rgba(120,165,255,0.4),0_6px_18px_-6px_rgba(79,140,255,0.7)]";
export const TOOL_PRIMARY = `h-8 whitespace-nowrap rounded-control bg-accent-strong px-3.5 text-white type-table-strong shadow-none disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted aria-disabled:cursor-not-allowed aria-disabled:bg-(--status-not-started-dark-bg) aria-disabled:text-muted ${GLOW} ${FOCUS}`;

/** The model-off note in the grey help line; the paused button points at it with aria-describedby. */
export function AiOffNote({
  id,
  note,
  testId,
}: {
  id: string;
  note: string | null;
  testId: string;
}) {
  if (note === null) return null;
  return (
    <p id={id} className="text-muted type-caption" data-testid={testId}>
      {note}
    </p>
  );
}

/** Props for a primary button that is paused while its note shows (aria-disabled keeps it focusable). */
export function pausedProps(note: string | null, noteId: string) {
  return note === null
    ? {}
    : { "aria-disabled": true as const, "aria-describedby": noteId };
}

/** Placements: the ghost AI entry button (32px, sparkle + label, 2px focus outline, no glow). Paused = aria-disabled. */
export const AI_GHOST = `inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-transparent px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-line ${FOCUS}`;

/** The small sparkle every AI entry point shows next to its label. */
export function Sparkle() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="currentColor">
      <path d="M8 1.5l1.3 3.6 3.7 1.4-3.7 1.4L8 11.5 6.7 7.9 3 6.5l3.7-1.4L8 1.5zM12.5 10.5l.6 1.6 1.4.6-1.4.6-.6 1.7-.6-1.7-1.4-.6 1.4-.6.6-1.6z" />
    </svg>
  );
}
