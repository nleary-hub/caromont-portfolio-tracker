import type { PhiKind } from "./AiPhiGuard";
import type { AiProviderId } from "./AiProviders";

/**
 * Every UI string of the AI writing assistant and Admin > AI settings (draft copy for Writing Bot; the PR body lists
 * them). No em dashes.
 */
export class AiCopy {
  // ---- Admin > AI settings -------------------------------------------------------------------------------------
  static readonly MENU_LABEL = "AI settings";
  static readonly PAGE_TITLE = "AI settings";
  static readonly PAGE_INTRO = "Only admins can see this page. These settings turn on the writing assistant for everyone who can edit a project. Every change is recorded below.";
  static readonly SWITCH_LABEL = "Writing assistant";
  static readonly SWITCH_HELP_OFF = "Off. No AI buttons show when anyone writes an update.";
  static readonly SWITCH_HELP_ON = "On. Editors see Draft from bullets and Fit for report when they write an update.";
  static readonly SWITCH_ON_NOT_READY = "On, but not ready. Add the provider, model and API key before anyone sees the buttons.";
  static readonly PROVIDER_LABEL = "Provider";
  static readonly PROVIDER_PLACEHOLDER = "Select a provider";
  static readonly MODEL_LABEL = "Model name";
  static readonly MODEL_HELP = "As the provider names it, for example gpt-4o-mini or claude-3-5-haiku-latest.";
  static readonly BASE_URL_LABEL = "Base URL";
  static readonly BASE_URL_HELP = "The provider's OpenAI-compatible API address, starting with https://. For example https://api.example.com/v1.";
  static readonly AZURE_ENDPOINT_LABEL = "Azure endpoint";
  static readonly AZURE_ENDPOINT_HELP = "For example https://your-resource.openai.azure.com.";
  static readonly AZURE_DEPLOYMENT_LABEL = "Deployment name";
  static readonly KEY_LABEL = "API key";
  static readonly KEY_NOT_SET = "Not set";
  static readonly KEY_PLACEHOLDER_NEW = "Paste the API key";
  static readonly KEY_PLACEHOLDER_REPLACE = "Paste a new key to replace it";
  static readonly KEY_HELP = "The key is encrypted when saved. It is never shown again, only whether it is set.";
  static readonly KEY_REPLACE = "Replace key";
  static readonly KEY_CANCEL_REPLACE = "Keep current key";
  static readonly KEY_CLEAR = "Clear key";
  static readonly KEY_CLEAR_CONFIRM = "Clear the API key? The writing assistant stops working until a new key is saved.";
  static readonly KEY_CLEAR_YES = "Clear key";
  static readonly KEY_CLEAR_NO = "Cancel";
  static readonly KEY_CLEARED = "API key cleared.";
  static readonly ENCRYPTION_MISSING =
    "The API key can't be saved until the server setting AI_SETTINGS_ENCRYPTION_KEY is set. Ask whoever manages the Vercel project to add it, then redeploy.";
  static readonly ENCRYPTION_INVALID =
    "The server setting AI_SETTINGS_ENCRYPTION_KEY is not a valid 32-byte base64 key, so the API key can't be saved or used. Ask whoever manages the Vercel project to fix it, then redeploy.";
  static readonly KEY_UNREADABLE = "The saved key can't be read with the current encryption key. Paste the key again to replace it.";
  static readonly SAVE = "Save";
  static readonly SAVING = "Saving…";
  static readonly SAVED = "Saved.";
  static readonly SAVE_FAILED = "Couldn't save the change. Try again.";
  static readonly FIX_FIELDS = "Fix the highlighted fields.";
  static readonly REQUIRED_PROVIDER = "Select a provider";
  static readonly REQUIRED_MODEL = "Enter the model name";
  static readonly INVALID_URL = "Enter an https:// address";
  static readonly REQUIRED_DEPLOYMENT = "Enter the deployment name";
  static readonly REQUIRED_KEY = "Add the API key";
  static readonly KEY_INVALID = "Paste the key exactly as the provider shows it";
  static readonly MODEL_TOO_LONG = "Use 100 characters or fewer";
  static readonly TEST = "Test connection";
  static readonly TESTING = "Testing…";
  static readonly TEST_HELP = "Sends a short test prompt with the saved settings. Save first if you changed anything.";
  static readonly TEST_NEEDS_SETTINGS = "Save a provider, model and API key first.";
  static readonly TEST_FAILED_PREFIX = "Connection failed.";
  static readonly HISTORY_TITLE = "Change log";
  static readonly HISTORY_EMPTY = "No changes yet.";
  static readonly HISTORY_HEADERS = ["When", "Who", "Field", "Change"] as const;
  static readonly STATUS_READY = "Ready";
  static readonly STATUS_OFF = "Off";
  static readonly STATUS_NOT_READY = "Not ready";
  static readonly DB_MISSING = "The AI settings tables are not in this database yet (migration 0033). Settings can't be saved here.";

  static testOk(provider: AiProviderId, ms: number): string {
    return `Connected. ${AiCopy.providerName(provider)} replied in ${ms.toLocaleString("en-US")} ms.`;
  }

  static keySet(last4: string): string {
    return last4 ? `Set, ending in ${last4}` : "Set";
  }

  static keySaved(when: string, who: string): string {
    return `Saved ${when} by ${who}`;
  }

  static fieldLabel(field: string): string {
    switch (field) {
      case "enabled":
        return AiCopy.SWITCH_LABEL;
      case "provider":
        return AiCopy.PROVIDER_LABEL;
      case "model":
        return AiCopy.MODEL_LABEL;
      case "baseUrl":
        return AiCopy.BASE_URL_LABEL;
      case "azureEndpoint":
        return AiCopy.AZURE_ENDPOINT_LABEL;
      case "azureDeployment":
        return AiCopy.AZURE_DEPLOYMENT_LABEL;
      case "apiKey":
        return AiCopy.KEY_LABEL;
      default:
        return field;
    }
  }

  /** The Change column of the change log. Key rows never carry a value. */
  static historyChange(field: string, action: string, oldValue: string | null, newValue: string | null): string {
    if (action === "key_set") return "Key added";
    if (action === "key_replaced") return "Key replaced";
    if (action === "key_cleared") return "Key cleared";
    const show = (v: string | null) => (v === null || v === "" ? "(none)" : field === "enabled" ? (v === "true" ? "On" : "Off") : field === "provider" ? AiCopy.providerName(v) : v);
    return `${show(oldValue)} to ${show(newValue)}`;
  }

  static providerName(p: string): string {
    switch (p) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "azure_openai":
        return "Azure OpenAI";
      case "openai_compatible":
        return "OpenAI-compatible";
      default:
        return p;
    }
  }

  // ---- Update-note editor --------------------------------------------------------------------------------------
  static readonly DRAFT_BUTTON = "Draft from bullets";
  static readonly FIT_BUTTON = "Fit for report";
  static readonly DRAFT_TOOLTIP = "Turn the notes in this field into a clean update of 2,000 characters or fewer. Nothing changes until you save the project.";
  static readonly FIT_TOOLTIP = "Shorten this update to 200 characters or fewer, the length the dashboard and report show. Nothing changes until you save the project.";
  static readonly PHI_HELPER = "Don't include patient information.";
  static readonly WORKING = "Writing…";
  static readonly EMPTY_INPUT = "Type some notes first.";
  static readonly PANEL_TITLE_DRAFT = "Suggested update";
  static readonly PANEL_TITLE_FIT = "Suggested short version";
  static readonly PANEL_ORIGINAL = "Your text";
  static readonly PANEL_SUGGESTION = "Suggestion";
  static readonly PANEL_NOTE = "Nothing changes until you save the project.";
  static readonly ACCEPT = "Accept";
  static readonly EDIT = "Edit";
  static readonly USE_EDITED = "Use this text";
  static readonly DISCARD = "Discard";
  static readonly ACCEPT_BLOCKED = "Use Edit to check the numbers and dates first.";
  static readonly OVER_LIMIT = "Over the limit. Use Edit to shorten it.";
  static readonly AI_ASSISTED_TAG = "AI-assisted";
  static readonly AI_ASSISTED_TOOLTIP = "Drafted with the writing assistant and accepted before saving.";
  static readonly RATE_LIMITED = "Too many AI requests in the last minute. Wait a moment and try again.";
  static readonly PROVIDER_ERROR = "The AI service didn't respond. Your note is unchanged. Try again in a moment.";
  static readonly TIMEOUT = "The AI service took too long to respond. Your note is unchanged. Try again in a moment.";
  static readonly UNAVAILABLE = "The writing assistant is off. Your note is unchanged.";
  static readonly NOT_ALLOWED = "You can't use the writing assistant on this project.";
  static readonly SUGGESTION_PHI = "The suggestion looks like it has patient information, so it can't be accepted. Discard it and try again.";

  /** Edit mode: the explicit override when the edited text still has numbers or dates that aren't in the original. */
  static readonly OVERRIDE_CHECKBOX = "I checked these numbers and dates against my notes.";
  /** Edit mode: shown next to the disabled "Use this text" while the number check fails and the box is not ticked. */
  static readonly USE_EDITED_BLOCKED = "Fix the numbers and dates above, or check the box to confirm them.";
  /** Under the field after Accept or "Use this text", until the project is saved; followed by the Undo link. */
  static readonly APPLIED_NOT_SAVED = "AI suggestion applied, not saved.";
  static readonly UNDO = "Undo";
  static readonly UNDONE = "Your original text is back.";
  /** Legend above the suggestion: one line per mark type (the amber line only when the number check fails). */
  static readonly LEGEND_WORDS = "Highlighted words aren't in your text.";
  static readonly LEGEND_NUMBERS = "Underlined numbers and dates aren't in your text. Check them before you use this.";
  /** Edit mode: label over the read-only marked suggestion shown above the edit box. */
  static readonly REFERENCE_LABEL = "Suggestion, for reference";

  /** Screen-reader label of each marked value (new word or missing number/date). */
  static notInText(value: string): string {
    return `${value}, not in your text`;
  }

  static numberWarning(missing: readonly string[]): string {
    return `These numbers or dates aren't in your text: ${missing.join(", ")}. Use Edit to check or remove them.`;
  }

  static count(n: number, limit: number): string {
    return `${n.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}`;
  }

  /** The PHI guard's plain message (nothing was sent). */
  static phiBlocked(kinds: readonly PhiKind[]): string {
    const names = kinds.map((k) => AiCopy.PHI_NAMES[k]);
    const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return `This might be patient information (${list}). Remove it and try again. Nothing was sent.`;
  }

  private static readonly PHI_NAMES: Record<PhiKind, string> = {
    mrn: "a medical record number",
    dob: "a date that could be a date of birth",
    ssn: "a Social Security number",
    phone: "a phone number",
    patient_name: "a name that could be a patient's",
  };
}
