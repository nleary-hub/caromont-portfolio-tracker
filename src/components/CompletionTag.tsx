import { CompletionCopy } from "@/lib/projects/CompletionCopy";

/**
 * "Auto" / "Manual" after the completion date in the side panel: the Start date "Default" tag's shape (16px, 10.5px
 * medium, 4px radius) in neutral tones, so amber stays reserved for "Completion date needed".
 */
export function CompletionTag({ source }: { source: "auto" | "manual" }) {
  return (
    <span
      title={source === "auto" ? CompletionCopy.AUTO_TOOLTIP : CompletionCopy.MANUAL_TOOLTIP}
      data-testid="completion-source"
      className="ml-1.5 inline-flex h-4 items-center rounded-[4px] border border-line px-1 align-middle text-[10.5px] leading-none font-medium text-muted"
    >
      {source === "auto" ? CompletionCopy.AUTO_TAG : CompletionCopy.MANUAL_TAG}
    </span>
  );
}
