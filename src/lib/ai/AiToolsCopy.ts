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
    meeting_brief: "Pre-meeting brief",
    related_links: "Related-project links",
    voice_chat: "Voice chat",
    template_ai: "Template AI assistant",
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
  /** Item C: one click for every open line (the per-line Apply, Reject and Edit stay). */
  static readonly APPLY_ALL = "Apply all";
  static readonly REJECT_ALL = "Reject all";
  static readonly APPLYING = "Applying...";
  static readonly ACTION_HEADERS = ["Project", "Change", "Now", "New", ""] as const;
  static readonly ACTION_REVIEW_HELP = "Apply all, or apply or reject each line. Applied changes are saved like a manual edit and show in History.";
  static readonly UNDONE = "Undone";
  static readonly NOT_APPLIED = "Not applied";
  static readonly EMPTY_VALUE = "\u2013";
  static readonly FEATURE_OFF_NOTE = "Turned off in AI settings.";
  static readonly AI_OFF_NOTE = "AI is turned off in AI settings.";
  static readonly MODEL_OFF_NOTE = "The AI model is turned off. An admin can turn one on in AI settings.";

  /** PR B (CTO item 4): the feature's provider has no saved key in Provider keys, so its button is unavailable. */
  static noKeyNote(provider: string): string {
    const name = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : provider === "xai" ? "xAI" : provider === "other" ? "Other provider" : provider;
    return `No saved ${name} key. An admin can add one in AI settings.`;
  }

  /** Whether a note is the no-saved-key note (any provider). */
  static isNoKeyNote(note: string | null | undefined): boolean {
    return typeof note === "string" && /^No saved .+ key\. An admin can add one in AI settings\.$/.test(note);
  }

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
  static readonly PREVIEW_OFF = "AI is turned off on preview deployments. Nothing was changed.";
  static readonly PREVIEW_OFF_NOTE = "AI is turned off on preview deployments.";

  /** A Vercel preview: no key is ever decrypted there, so AI is off with its own message. */
  static isPreview(env: Record<string, string | undefined> = process.env): boolean {
    return env.VERCEL_ENV === "preview";
  }

  static aiOff(env: Record<string, string | undefined> = process.env): string {
    return AiToolsCopy.isPreview(env) ? AiToolsCopy.PREVIEW_OFF : AiToolsCopy.AI_OFF;
  }

  static aiOffNote(env: Record<string, string | undefined> = process.env): string {
    return AiToolsCopy.isPreview(env) ? AiToolsCopy.PREVIEW_OFF_NOTE : AiToolsCopy.AI_OFF_NOTE;
  }
  static readonly PROVIDER_ERROR = "The AI service didn't respond. Nothing was changed. Try again in a moment.";
  static readonly TIMEOUT = "The AI service took too long to respond. Nothing was changed. Try again in a moment.";
  static readonly PARSE_FAILED = "The AI reply couldn't be read. Nothing was changed. Try again.";

  // Step 4: Meeting notes to updates.
  static readonly MEETING_TITLE = "Meeting notes to updates";
  static readonly MEETING_HELP = "Paste or dictate notes from a meeting. The AI matches each note to its project (by name, REQ number, vendor or owner) and suggests status, people, milestone, blocker and Latest update changes, one line per project. New projects come back as drafts, and notes it could not match are listed. Nothing changes until you apply it.";
  static readonly MEETING_REFUSED_TITLE = "Not suggested";
  static readonly MEETING_DRAFTS_TITLE = (n: number) => (n === 1 ? "New project mentioned (draft)" : `New projects mentioned (${n} drafts)`);
  static readonly MEETING_UNMATCHED_TITLE = (n: number) => (n === 1 ? "1 note matched no project" : `${n} notes matched no project`);
  static readonly MEETING_UNMATCHED_HELP = "Nothing was suggested for these. Add them by hand or name the project and try again.";
  static readonly MEETING_LABEL = "Meeting notes";
  static readonly MEETING_PLACEHOLDER = "For example: Example Clinic refresh is on hold until the vendor confirms. Sample Lab move, due date now Dec 1.";

  // Step 5: Plain-English bulk edit.
  static readonly BULK_TITLE = "Plain-English bulk edit";
  static readonly BULK_HELP = "Describe one change for many projects at once. The AI turns it into a filter and one change; you see the filter in plain words, then each matching project with before and after. It can change status, next milestone, dates, owner, contracts lead, requester, department or the current milestone's owner, complete the current milestone, or mark projects reviewed, never the Latest update.";
  static readonly BULK_UNREADABLE = "The AI couldn't turn that into one filter and one change. Nothing was changed. Try one change at a time, for example: Set the owner of every EP project with no owner to Avery Lin.";
  static readonly BULK_NO_MATCH = "No project matches that filter. Nothing to change.";
  static readonly BULK_NOTHING_TO_CHANGE = "Every matching project already has that value. Nothing to change.";
  static readonly bulkAlready = (n: number) => (n === 1 ? "1 matching project already has that value." : `${n} matching projects already have that value.`);
  static readonly BULK_LABEL = "What should change?";
  static readonly BULK_FILTER_LABEL = "Filter";
  static readonly BULK_ACTION_LABEL = "Change";
  static readonly BULK_COUNT_LABEL = "Projects";
  static readonly BULK_PLACEHOLDER = "For example: Move every On hold project due in November to December 1.";

  // Step 6: Quick capture and dictation.
  static readonly CAPTURE_TITLE = "Quick capture";
  static readonly CAPTURE_HELP = "Type or dictate one rough line. The AI finds the project and drafts the update for you to review.";
  static readonly CAPTURE_LABEL = "Rough update";
  static readonly COMMAND_TITLE = "Command bar";
  static readonly COMMAND_HELP = "Ask about your projects or type changes in plain words, one project or several (names, REQ numbers or vendors). Changes show below for review and apply only after you click Apply or type yes.";
  static readonly COMMAND_LABEL = "Request";
  static readonly COMMAND_PLACEHOLDER = "For example: REQ-1042 drywall done, example vendor slipped to Nov 3";
  static readonly COMMAND_SEND = "Send";
  static readonly COMMAND_THINKING = "Working\u2026";
  static readonly COMMAND_EMPTY = "Type a request first.";
  static readonly COMMAND_UNREADABLE = "Sorry, I couldn't work that out. Try saying it another way.";
  static readonly COMMAND_TOO_MANY = "That took too many steps. Try one request at a time.";
  static readonly COMMAND_CLEAR = "New conversation";
  static readonly COMMAND_YOU = "You";
  static readonly CLOSE = "Close";
  static readonly COMMAND_AI = "AI";
  static readonly CAPTURE_PLACEHOLDER = "For example: example clinic refresh slipped, vendor delay";
  static readonly DICTATE = "Dictate";
  static readonly DICTATE_STOP = "Stop and transcribe";
  static readonly TRANSCRIBING = "Transcribing…";
  static readonly DICTATION_HELP = "Recordings are turned into text and then discarded. Read the text before you ask for suggestions.";
  static readonly DICTATION_NO_MIC = "The microphone isn't available in this browser.";
  static readonly DICTATION_FAILED = "The recording couldn't be transcribed. Nothing was changed. Try again or type instead.";
  static readonly DICTATION_TOO_LONG = "Recordings can be up to 2 minutes.";
  static readonly DICTATION_NO_MODEL = "No dictation model is chosen in AI settings.";
  static readonly DICTATION_MODEL_LABEL = "Dictation model";
  static readonly DICTATION_MODEL_NONE = "Choose a model";
  static readonly DICTATION_MODEL_HELP = "Dictation needs a speech-to-text model, such as a gpt-transcribe model. Only transcription models that are on are listed.";

  // Step 7: Next-step suggestion.
  static readonly NEXT_TITLE = "Next-step suggestion";
  static readonly NEXT_HELP = "Pick a project. The AI reads its Latest update and suggests one next milestone, and a due date when the update supports one.";
  static readonly NEXT_PROJECT_LABEL = "Project";
  static readonly NEXT_PROJECT_NONE = "Choose a project";
  static readonly NEXT_PROPOSE = "Suggest next step";
  static readonly NEXT_INSTRUCTION = "Suggest the next milestone for this project.";
  static readonly NEXT_MILESTONE_LABEL = "Next milestone";
  static readonly NEXT_OWNER_LABEL = "Owner";
  static readonly NEXT_DUE_LABEL = "Due";
  static readonly NEXT_THIS_WEEK_LABEL = "This week";
  static readonly NEXT_WHY_LABEL = "Why";
  static readonly NEXT_TEMPLATE_LABEL = "Template";
  static readonly NEXT_IN_PLAN = "in the plan";
  static readonly NEXT_NEW = "new milestone";
  static readonly NEXT_NO_OWNER = "No owner assigned";
  static readonly NEXT_NO_DATE = "No date suggested";
  static readonly NEXT_ALREADY = "The plan already has this as the current milestone, with this owner and date. Nothing to change.";
  static readonly NEXT_MOVED = "Next-step suggestion is now on each project: the row's ... menu (Recommend next milestone) and the project drawer. It reads the milestone plan and template, not just the Latest update.";
  static readonly PICK_PROJECT = "Choose a project first.";
  static readonly NO_PROJECTS = "No open projects in this service line.";

  // Step 7: Request to draft project.
  static readonly REQUEST_TITLE = "Request to draft project";
  static readonly REQUEST_HELP = "Paste a project request. The AI drafts a new project for you to check. Owner, physician champion, requester and department stay blank for you to fill in.";
  static readonly REQUEST_LABEL = "Project request";
  static readonly REQUEST_PLACEHOLDER = "For example: Example Clinic asks for a second ultrasound room by June 30. Needs a vendor quote first.";
  static readonly REQUEST_PROPOSE = "Draft project";
  static readonly DRAFT_TITLE = "Review draft project";
  static readonly DRAFT_HELP = "Edit anything before you create it. It's created as Not started, with owner, physician champion, requester and department blank.";
  static readonly DRAFT_CREATE = "Create project";
  static readonly DRAFT_DISCARD = "Discard";
  static readonly DRAFT_CREATED = "Project created. Open it on the dashboard to fill in the owner, physician champion, requester and department.";
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

  // Step 8: Pre-meeting brief.
  static readonly PLAYBOOK_TITLE = "Meeting Playbook";
  static readonly PLAYBOOK_INTRO = "Pick the meeting, who it covers and how long it is. The AI drafts the playbook from your projects; the watchlist and blocker lists are computed by the tracker. Saved playbooks can be reopened below.";
  static readonly PLAYBOOK_TYPE = "Meeting type";
  static readonly PLAYBOOK_SCOPE = "Covers";
  static readonly PLAYBOOK_SCOPE_LINE = "All projects in this line";
  static readonly PLAYBOOK_SCOPE_DEPT = "A department";
  static readonly PLAYBOOK_SCOPE_OWNER = "An owner";
  static readonly PLAYBOOK_SCOPE_PICKED = "Projects from the dashboard";
  static readonly PLAYBOOK_LENGTH = "Length";
  static readonly PLAYBOOK_FOCUS = "Focus (optional)";
  static readonly PLAYBOOK_FOCUS_PLACEHOLDER = "For example: the supply contract and what it holds up";
  static readonly PLAYBOOK_MAKE = "Make playbook";
  static readonly PLAYBOOK_MAKING = "Making playbook\u2026";
  static readonly PLAYBOOK_SAVED = "Saved playbooks";
  static readonly PLAYBOOK_NONE_SAVED = "No saved playbooks yet.";
  static readonly PLAYBOOK_INVALID = "Pick a meeting type, who it covers and a length.";
  static readonly PLAYBOOK_NO_PROJECTS = "No projects match that choice in this line.";
  static readonly PLAYBOOK_COPY = "Copy";
  static readonly PLAYBOOK_COPIED = "Copied.";
  static readonly PLAYBOOK_PRINT = "Print or PDF";
  static readonly PLAYBOOK_WORD = "Export to Word";
  static readonly PLAYBOOK_EMAIL = "Email-ready text";
  static readonly PLAYBOOK_PROCESS = "Process meeting notes";
  static readonly PLAYBOOK_PROCESS_HELP = "Paste or dictate your notes from this meeting. They go through Meeting notes to updates with this playbook's follow-ups as context. Nothing changes until you apply it.";
  static readonly PLAYBOOK_SECTIONS = ["Bottom line", "Decisions and escalations needed", "Agenda", "Project talking points", "Watchlist", "Dependencies and patterns", "Wins to recognize", "Follow-up tracker"] as const;
  static readonly PLAYBOOK_NOTE = "AI-written from the tracker's data. The watchlist and blocker lists are computed by the tracker. Check the linked projects before the meeting.";
  static readonly PLAYBOOK_NONE = "None.";
  static readonly PLAYBOOK_FOLLOW_HEADERS = ["Action", "Owner", "Due", "Project"] as const;
  static readonly PLAYBOOK_OPEN = "Meeting Playbook";
  static readonly PLAYBOOK_NEW = "New playbook";
  static readonly PLAYBOOK_BUTTON = "Playbook";
  static readonly AI_MENU_PLAYBOOK = (n: number) => (n ? `Meeting Playbook for ${n} selected` : "Meeting Playbook for these projects");
  static selectionLabel(n: number): string {
    return `${n} selected ${n === 1 ? "project" : "projects"} from the dashboard`;
  }
  static filterLabel(n: number): string {
    return `${n} ${n === 1 ? "project" : "projects"} in the dashboard filter`;
  }
  static readonly BRIEF_TITLE = "Pre-meeting brief";
  static readonly BRIEF_HELP = "One click makes a one-page brief from the projects in this service line: what moved, what's stuck and what to ask. It's shown here only. It isn't saved, emailed or added to any report.";
  static readonly BRIEF_LABEL = "Focus (optional)";
  static readonly BRIEF_PLACEHOLDER = "For example: Imaging, or projects owned by Sample Owner";
  static readonly BRIEF_PROPOSE = "Make brief";
  static readonly BRIEF_DEFAULT = "All projects in this service line.";
  static readonly BRIEF_MOVED = "What moved";
  static readonly BRIEF_STUCK = "What's stuck";
  static readonly BRIEF_ASK = "What to ask";
  static readonly BRIEF_EMPTY = "Nothing to list.";
  static readonly BRIEF_NOTE = "AI-written from each project's status and Latest update. Check the linked projects before the meeting.";

  // Step 9: Related-project links.
  static readonly LINKS_TITLE = "Related-project links";
  static readonly LINKS_HELP = "The AI looks for projects that share a vendor, a location or a blocker and suggests links. Each link is added only when you confirm it. Links don't change any project or report.";
  static readonly LINKS_PROPOSE = "Suggest links";
  static readonly LINKS_REVIEW_TITLE = "Review suggested links";
  static readonly LINKS_HEADERS = ["Project", "Related project", "Why", ""] as const;
  static readonly LINK_CONFIRM = "Link";
  static readonly LINK_LINKED = "Linked";
  static readonly LINKS_NONE = "The AI found no new links to suggest.";
  static readonly LINKS_SAVED_TITLE = "Confirmed links";
  static readonly LINKS_SAVED_EMPTY = "No links yet.";
  static readonly LINK_REMOVE = "Remove";
  static readonly LINK_REMOVED = "Link removed.";

  static fieldLabel(field: string): string {
    return AiToolsCopy.FIELD_LABELS[field] ?? field;
  }

  static bulkMatched(n: number): string {
    return n === 1 ? "1 project matches the filter." : `${n} projects match the filter.`;
  }

  static bulkChanged(n: number): string {
    if (n === 0) return "None will become Changed.";
    return n === 1 ? "1 will become Changed when its line is applied." : `${n} will become Changed when their lines are applied.`;
  }

  static applied(n: number): string {
    return n === 1 ? "1 change applied." : `${n} changes applied.`;
  }

  // Step 10: Voice chat.
  static readonly VOICE_CHAT_TITLE = "Voice chat";
  static readonly NEXT_INLINE = "Recommend next milestone";
  static readonly BRIEF_OPEN_FULL = "Open full";
  static readonly BRIEF_CARD_TITLE = "Pre-meeting brief";
  static readonly BRIEF_BUTTON = "Brief";
  static readonly LINKS_FIND = "Find related";
  static readonly LINK_DISMISS = "Dismiss";
  static readonly RECORDING = "Recording";
  static readonly ROW_MENU_LABEL = "More actions";
  static readonly ROW_DRAFT = "Draft with AI";
  static readonly LINKS_SUGGESTED_TITLE = "Suggested related projects";
  static readonly AI_MENU = "AI";
  static readonly AI_MENU_BULK = (n: number) => `Bulk edit selected (${n})`;
  static readonly AI_MENU_MEETING = "Meeting notes to updates";
  static readonly AI_MENU_SELECT_FIRST = "Select one or more rows first.";
  static readonly AI_MENU_SELECT_HINT = "Ctrl-click or Cmd-click rows to select them.";
  static readonly CAPTURE_BUTTON = "Quick capture";
  static readonly CAPTURE_SHORTCUT = "Shortcut: Q";
  static readonly selectionLine = (n: number, names: string) => `Working on ${n} selected ${n === 1 ? "project" : "projects"}: ${names}.`;
  static readonly visibleLine = (n: number) => `Working on the ${n} ${n === 1 ? "project" : "projects"} in view.`;
  static readonly scopePrefix = (names: string) => `Only change these projects: ${names}.`;
  static readonly VOICE_CHAT_HELP = "Ask about your projects out loud. The AI reads back any change and applies it only after you say yes. You can also apply or reject it below. Say 'undo that' to undo the last apply.";
  static readonly VOICE_START = "Start voice chat";
  static readonly VOICE_STOP = "End chat";
  static readonly VOICE_CONNECTING = "Connecting\u2026";
  static readonly VOICE_LISTENING = "Listening";
  static readonly VOICE_SPEAKING = "Answering";
  static readonly VOICE_PRIVACY = "Audio goes straight to the AI provider and is never saved here. Only minutes and cost are logged.";
  static readonly VOICE_NO_MIC = "The microphone isn't available. Check this site's microphone permission in your browser.";
  static readonly VOICE_START_FAILED = "Voice chat couldn't start. Try again in a moment.";
  static readonly VOICE_MODEL_UNAVAILABLE = "OpenAI rejected the selected voice model. An admin can choose a gpt-realtime or gpt-live model in AI settings.";
  static readonly VOICE_TOKEN_FAILED = "OpenAI didn't open a voice session. Try again in a moment. If it keeps happening, an admin can check the API key in AI settings.";
  static readonly VOICE_MIC_DENIED = "Microphone access is blocked for this site. Allow it in your browser, then try again.";
  static readonly VOICE_CONNECT_FAILED = "The voice connection couldn't be set up. Check your network, then try again.";
  static readonly VOICE_ICE_FAILED = "Voice couldn't connect. Your network may be blocking live audio. Try a different network.";
  static readonly VOICE_DROPPED = "The connection dropped. Start again to keep talking.";
  static readonly VOICE_TIME_UP = "The chat reached its time limit. Start again to keep talking.";
  static readonly VOICE_ONE_MINUTE = "One minute left in this chat.";
  static readonly VOICE_TRANSCRIPT = "Transcript";
  static readonly VOICE_TRANSCRIPT_NOTE = "Shown here only. The transcript is not saved.";
  static readonly VOICE_YOU = "You";
  static readonly VOICE_AI = "AI";
  /** The chat's limit in the help line ("Chats end after 15 minutes."). */
  static voiceLimit(seconds: number): string {
    const m = Math.round(seconds / 60);
    return `Chats end after ${m} ${m === 1 ? "minute" : "minutes"}.`;
  }
  static readonly VOICE_SESSION_GONE = "This voice chat has ended. Start a new one.";
  static readonly VOICE_MODEL_LABEL = "Voice chat model";
  static readonly VOICE_BACKEND_MODEL_OFF = "Live voice models use the writing assistant model to answer. An admin needs to choose that model and turn it on in AI settings.";
  static readonly VOICE_MODEL_HELP = "Voice chat needs a gpt-realtime or gpt-live model. Click Show OpenAI models to see the ones your saved API key can use. Only models turned on under Models can be saved.";

  /** Own-model features (step 6, step 10): the model picker's label and help on Admin > AI settings. */
  static modelLabel(feature: string): string {
    return feature === "voice_chat" ? AiToolsCopy.VOICE_MODEL_LABEL : AiToolsCopy.DICTATION_MODEL_LABEL;
  }

  static modelHelp(feature: string): string {
    return feature === "voice_chat" ? AiToolsCopy.VOICE_MODEL_HELP : AiToolsCopy.DICTATION_MODEL_HELP;
  }
}
