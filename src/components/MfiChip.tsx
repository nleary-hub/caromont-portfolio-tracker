"use client";

import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";

/** MFI colors (Figma Bro's spec, Oct 15, 2026): 1.5px purple border, lavender text, transparent fill. */
export const MFI_BORDER = "#6B4FB0";
export const MFI_TEXT = "#E6E0F7";

/** "MFI" chip after the project name (list) and the drawer title. Plain text, no diamond (the PDF badge has one). */
export function MfiChip() {
  return (
    <span
      data-testid="mfi-chip"
      title="Major Facility Investment"
      className="ml-1.5 inline-flex shrink-0 items-center rounded-full px-1.5 align-middle text-[10px] leading-[14px] font-extrabold tracking-[.04em]"
      style={{ border: `1.5px solid ${MFI_BORDER}`, color: MFI_TEXT, background: "transparent" }}
    >
      {ProjectFormModel.MFI_CHIP}
    </span>
  );
}

/**
 * Drawer "Major Facility Investment (MFI)" checkbox, below a divider and above the Admin box. Admins edit it (drawer
 * auto-save through saveProjectForm, which writes history); everyone else sees it disabled.
 */
export function MfiCheckbox({ checked, onChange }: { checked: boolean; onChange?: (checked: boolean) => void }) {
  const readOnly = !onChange;
  return (
    <div className="mt-2 border-t border-line pt-3" data-testid="mfi-field" data-readonly={readOnly || undefined}>
      <label className={`flex items-center gap-2 type-table ${readOnly ? "cursor-default" : "cursor-pointer"}`}>
        <input
          type="checkbox"
          data-testid="mfi-checkbox"
          className="size-4 accent-[#6B4FB0]"
          checked={checked}
          disabled={readOnly}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span>{ProjectFormModel.MFI_LABEL}</span>
      </label>
    </div>
  );
}
