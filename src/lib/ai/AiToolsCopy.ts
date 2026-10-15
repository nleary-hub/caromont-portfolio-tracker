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
    bulk_edit: "Plain-English bulk edit",
    quick_capture: "Quick capture",
    dictation: "Dictation (speech to text)",
    next_step: "Next-step suggestion",
    request_to_project: "Request to draft project",
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

  // Step 5: Plain-English bulk edit.
  static readonly BULK_TITLE = "Plain-English bulk edit";
  static readonly BULK_HELP = "Describe a change for many projects at once. The AI lists each project it would change, with before and after. It can change status, next milestone and dates, never the update note.";
  static readonly BULK_LABEL = "What should change?";
  static readonly BULK_PLACEHOLDER = "For example: Move every On hold project due in November to December 1.";

  // Step 6: Quick capture and dictation.
  static readonly CAPTURE_TITLE = "Quick capture";
  static readonly CAPTURE_HELP = "Type or dictate one rough line. The AI finds the project and drafts the update for you to review.";
  static readonly CAPTURE_LABEL = "Rough update";
  static readonly CAPTURE_PLACEHOLDER = "For example: example clinic refresh slipped, vendor delay";
  static readonly DICTATE = "Dictate";
  static readonly DICTATE_STOP = "Stop and transcribe";
  static readonly TRANSCRIBING = "Transcribing…";
  static readonly DICTATION_HELP = "Recordings are turned into text and then discarded. Read the text before you ask for suggestions.";
  static readonly DICTATION_NO_MIC = "The microphone isn't available in this browser.";
  static readonly DICTATION_FAILED = "The recording couldn't be transcribed. Nothing was changed. Try again or type instead.";
  static readonly DICTATION_TOO_LONG = "Recordings can be up to 2 minutes.";
  static readonly DICTATION_NO_MODEL = "No dictation model chosen in AI settings";
  static readonly DICTATION_MODEL_LABEL = "Dictation model";
  static readonly DICTATION_MODEL_NONE = "Choose a model";
  static readonly DICTATION_MODEL_HELP = "Dictation needs a speech-to-text model, such as a gpt-transcribe model. Only models that are on are listed.";

  // Step 7: Next-step suggestion.
  static readonly NEXT_TITLE = "Next-step suggestion";
  static readonly NEXT_HELP = "Pick a project. The AI reads its Latest update and suggests one next milestone, and a due date when the update supports one.";
  static readonly NEXT_PROJECT_LABEL = "Project";
  static readonly NEXT_PROJECT_NONE = "Choose a project";
  static readonly NEXT_PROPOSE = "Suggest next step";
  static readonly NEXT_INSTRUCTION = "Suggest the next milestone for this project.";
  static readonly PICK_PROJECT = "Choose a project first.";
  static readonly NO_PROJECTS = "No open projects in this service line.";

  // Step 7: Request to draft project.
  static readonly REQUEST_TITLE = "Request to draft project";
  static readonly REQUEST_HELP = "Paste a project request. The AI drafts a new project for you to check. Owner, physician, requester and department stay blank for you to fill in.";
  static readonly REQUEST_LABEL = "Project request";
  static readonly REQUEST_PLACEHOLDER = "For example: Example Clinic asks for a second ultrasound room by June 30. Needs a vendor quote first.";
  static readonly REQUEST_PROPOSE = "Draft project";
  static readonly DRAFT_TITLE = "Review draft project";
  static readonly DRAFT_HELP = "Edit anything before you create it. It's created as Not started, with no owner or department.";
  static readonly DRAFT_CREATE = "Create project";
  static readonly DRAFT_DISCARD = "Discard";
  static readonly DRAFT_CREATED = "Project created. Open it on the dashboard to assign an owner and department.";
  static readonly DRAFT_DISCARDED = "Draft discarded. Nothing was created.";
  static readonly DRAFT_INVALID = "Check the draft: a name is required, and dates must be real dates.";
  static readonly DRAFT_LABELS: Readonly<Record<string, string>> = {
    name: "Name",
    description: "Description",
    nextMilestone: "Next milestone",
    dueDate: "Due date",
    targetCompletion: "Target completion",
    note: "Latest update",
  };

  static fieldLabel(field: string): string {
    return AiToolsCopy.FIELD_LABELS[field] ?? field;
  }

  static applied(n: number): string {
    return n === 1 ? "1 change applied." : `${n} changes applied.`;
  }
}
