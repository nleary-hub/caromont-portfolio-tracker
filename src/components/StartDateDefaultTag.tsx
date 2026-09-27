import { StartDate } from "@/lib/projects/StartDate";

/**
 * Small muted amber "Default" tag: the start date is still the import default (Project.startDateIsDefault). Drawer
 * only (edit form label, Project detail); never on dashboard rows or in the PDF.
 */
export function StartDateDefaultTag() {
  return (
    <span
      title={StartDate.DEFAULT_TOOLTIP}
      data-testid="start-date-default"
      className="ml-1.5 inline-flex h-4 items-center rounded-[4px] px-1 align-middle text-[10.5px] leading-none font-medium"
      style={{ background: "var(--status-at-risk-dark-bg)", color: "var(--status-at-risk-dark-fg)", opacity: 0.8 }}
    >
      {StartDate.DEFAULT_TAG}
    </span>
  );
}
