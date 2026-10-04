import type { ComboVariant } from "@/lib/people/PeopleComboboxModel";

/** Milestone owner copy (Writing Bot): field label "Owner", empty "Unassigned", the picker's clear option "No owner". */
export class MilestoneOwnerCopy {
  static readonly LABEL = "Owner";
  static readonly UNASSIGNED = "Unassigned";
  static readonly CLEAR = "No owner";
  /** Picker: names from the line's Owners list only (no "Add 'X'"); former staff are already left out by PeopleDirectory.merge. */
  static readonly VARIANT: ComboVariant = { clearLabel: MilestoneOwnerCopy.CLEAR, unsetText: MilestoneOwnerCopy.UNASSIGNED, allowAdd: false };
}
