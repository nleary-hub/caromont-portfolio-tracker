/**
 * User-facing text of the Template AI assistant (Admin > Milestone templates). Plain language, no em dashes. Every string
 * here is listed in the PR body for the copy review.
 */
export class AiTemplateCopy {
  static readonly DRAFT_BUTTON = "Draft a template with AI";
  static readonly EDIT_BUTTON = "Edit with AI";
  static readonly DRAFT_TITLE = "Draft a template";
  static readonly EDIT_TITLE = "Edit with AI";
  static readonly CLOSE = "Close";
  static readonly DRAFT_PLACEHOLDER = "Describe the template, e.g. 6 milestones for a new clinic opening";
  static readonly EDIT_PLACEHOLDER = "Describe the change, e.g. add a go-live check and shorten the names";
  static readonly PROMPT_LABEL = "What should the AI do?";
  static readonly DRAFT = "Draft";
  static readonly PROPOSE = "Suggest changes";
  static readonly LOADING = "Working on your suggestions…";
  static readonly REVIEW_HELP = "Review each change. Nothing is saved until you apply.";
  static readonly DEFAULT_NAME = "New template";

  // Row tags.
  static readonly TAG_ADDED = "Added";
  static readonly TAG_REMOVED = "Removed";
  static readonly TAG_REWORDED = "Reworded";
  static readonly TAG_MOVED = "Moved";
  static readonly TAG_NAME = "Name";
  static readonly APPLY = "Apply";
  static readonly SKIP = "Skip";
  static movedFrom(pos: number): string {
    return `Moved from #${pos}`;
  }

  // Footer.
  static readonly DISCARD = "Discard";
  static readonly APPLY_ALL = "Apply all";
  static readonly APPLY_SELECTED = "Apply selected";
  static readonly SAVING = "Saving…";
  static readonly SAVED = "Saved";
  static summary(c: { added: number; removed: number; reworded: number; moved: number }): string {
    return `${c.added} added · ${c.removed} removed · ${c.reworded} reworded · ${c.moved} moved`;
  }

  // Validation (MilestoneRules: 40 characters, no blanks, no duplicates).
  static readonly ISSUE_BLANK = "This name is blank. It can't be applied.";
  static issueTooLong(length: number, max: number): string {
    return `${length} characters, over the ${max} limit. It can't be applied.`;
  }
  static issueDuplicate(pos: number): string {
    return `Same name as #${pos}. It can't be applied.`;
  }
  static issueTooMany(max: number): string {
    return `A template can have at most ${max} milestones. Skip some milestones first.`;
  }
  static readonly INVALID_FLAGGED = "Flagged milestones can't be applied. Skip them or try again.";
  static readonly FINAL_INVALID = "These choices would leave a name blank, too long or duplicated. Change your choices and try again.";

  // Errors (red alert box).
  static readonly EMPTY_DRAFT = "The AI didn't suggest any milestones. Nothing was changed. Try describing the template another way.";
  static readonly NO_CHANGES = "The AI found no changes to suggest. Nothing was changed.";
  static readonly TEMPLATE_CHANGED = "This template changed since the AI read it. Nothing was saved. Close and try again.";
  static readonly APPLY_FAILED = "The changes couldn't be saved. Nothing was changed. Try again.";
}
