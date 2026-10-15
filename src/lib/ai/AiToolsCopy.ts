/**
 * User-facing text of the AI tools page (steps 4 to 9). Plain language, no em dashes. Every string here is in the
 * PR body for the copy review.
 */
export class AiToolsCopy {
  static readonly PAGE_TITLE = "AI tools";
  static readonly PAGE_INTRO = "The AI suggests changes. Nothing is saved until you apply a line. Each applied line is saved like a manual edit, with its own history entry.";
  static readonly MENU_LABEL = "AI tools";
  static readonly AI_LABEL = "AI suggestion";

  static readonly FEATURE_LABELS: Readonly<Record<string, string>> = {
    meeting_notes: "Meeting notes to updates",
  };

  // Shared review list.
  static readonly PROPOSE = "Suggest changes";
  static readonly PROPOSING = "Reading…";
  static readonly REVIEW_TITLE = "Review suggested changes";
  static readonly REVIEW_HELP = "Apply or reject each line. You can edit a value before you apply it.";
  static readonly HEADERS = ["Project", "Field", "Now", "Suggested", ""] as const;
  static readonly APPLY = "Apply";
  static readonly REJECT = "Reject";
  static readonly APPLIED = "Applied";
  static readonly REJECTED = "Rejected";
  static readonly NO_CHANGES = "The AI found no changes to suggest.";
  static readonly EMPTY_VALUE = "(blank)";
  static readonly FEATURE_OFF_NOTE = "Turned off in AI settings.";
  static readonly AI_OFF_NOTE = "AI turned off in settings";
  static readonly MODEL_OFF_NOTE = "AI model turned off in settings";

  static readonly FIELD_LABELS: Readonly<Record<string, string>> = {
    status: "Status",
    nextMilestone: "Next milestone",
    dueDate: "Due date",
    targetCompletion: "Target completion",
    note: "Latest update",
  };

  // Errors.
  static readonly INPUT_EMPTY = "Type or paste some text first.";
  static readonly APPLY_FAILED = "That change couldn't be saved. The project is unchanged.";
  static readonly VALUE_INVALID = "That value isn't valid for this field. Edit it or reject the line.";
  static readonly FEATURE_OFF = "This AI tool is turned off. Nothing was changed.";
  static readonly AI_OFF = "AI is turned off in AI settings. Nothing was changed.";
  static readonly PROVIDER_ERROR = "The AI service didn't respond. Nothing was changed. Try again in a moment.";
  static readonly TIMEOUT = "The AI service took too long to respond. Nothing was changed. Try again in a moment.";
  static readonly PARSE_FAILED = "The AI reply couldn't be read. Try again.";

  // Step 4: Meeting notes to updates.
  static readonly MEETING_TITLE = "Meeting notes to updates";
  static readonly MEETING_HELP = "Paste notes from a meeting. The AI suggests status, next milestone, date and update changes for the projects the notes mention.";
  static readonly MEETING_LABEL = "Meeting notes";
  static readonly MEETING_PLACEHOLDER = "For example: Example Clinic refresh is on hold until the vendor confirms. Sample Lab move, due date now Dec 1.";

  static fieldLabel(field: string): string {
    return AiToolsCopy.FIELD_LABELS[field] ?? field;
  }

  static applied(n: number): string {
    return n === 1 ? "1 change applied." : `${n} changes applied.`;
  }
}
