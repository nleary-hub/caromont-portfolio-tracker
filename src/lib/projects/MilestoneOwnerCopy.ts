import type { ComboVariant } from "@/lib/people/PeopleComboboxModel";

/** Milestone owner copy (Writing Bot): field label "Owner", empty "Unassigned", the picker's clear option "No owner". */
export class MilestoneOwnerCopy {
  static readonly LABEL = "Owner";
  static readonly UNASSIGNED = "Unassigned";
  static readonly CLEAR = "No owner";
  /** Screen-reader label of a step's owner picker (Writing Bot). */
  static ariaLabel(step: number): string {
    return `Owner for step ${step}`;
  }
  /**
   * Picker: names from the line's Owners, Requesters and Contracts leads lists plus the milestone-owner list, and
   * "Add 'X'" for a typed new name (saved to the milestone-owner list, no prompt). Former staff are left out by
   * PeopleDirectory.merge and can't be added.
   */
  static readonly VARIANT: ComboVariant = { clearLabel: MilestoneOwnerCopy.CLEAR, unsetText: MilestoneOwnerCopy.UNASSIGNED, allowAdd: true };
}
