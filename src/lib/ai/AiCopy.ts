import { AiToolsCopy } from "./AiToolsCopy";
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
  /** Placeholder for Writing Bot (step 3b). */
  static readonly SWITCH_ON_MODEL_OFF = "On, but not ready. The chosen model is turned off under Models. Choose a model that is on.";
  static readonly PROVIDER_LABEL = "Provider";
  static readonly PROVIDER_PLACEHOLDER = "Select a provider";
  static readonly MODEL_LABEL = "Model name";
  /** Placeholder copy for Writing Bot to finalize (step 3b: admins choose the models). */
  static readonly MODEL_HELP = "Choose a chat model. Click Show OpenAI models to see every model your saved API key can use. Only models turned on under Models can be saved.";
  /** Save or call with a model that isn't turned on under Models. Placeholder for Writing Bot. */
  static readonly MODEL_NOT_ALLOWED = "That model is turned off. An admin can choose one that's on in AI settings.";
  static readonly MODEL_PICKER_EMPTY = "No models are on. Turn one on under Models.";
  static readonly MODEL_PICKER_PLACEHOLDER = "Choose a model";
  static readonly MODEL_PICKER_OFF = "Off under Models";
  static readonly MODEL_PICKER_MANUAL_LABEL = "Or type a model ID";
  static readonly MODEL_PICKER_LIST_FAILED = "Couldn't load OpenAI's model list. You can still type a model ID under each picker. Only models turned on under Models can be used.";
  static readonly TEST_MODEL_LABEL = "Model to test";
  static readonly TEST_PICK_MODEL = "Pick a model to test first.";

  // ---- Admin > AI settings: Models and Features (step 3b) -----------------------------------------------------------
  static readonly MODELS_TITLE = "Models";
  static readonly MODELS_INTRO = "OpenAI models admins can choose. New models start off. Enter prices by hand, or refresh them from OpenAI's pricing page. Prices are for reference only.";
  static readonly MODELS_HEADERS = ["Model", "On", "Price unit", "Input price", "Output price", ""] as const;
  static readonly MODELS_EMPTY = "No models yet.";
  static readonly MODEL_IN_USE = "In use";
  /** Placeholder for Writing Bot: the chosen model is turned off. */
  static readonly MODEL_CHOSEN_OFF = "Chosen, but off";
  static readonly MODEL_ADD_LABEL = "Add an OpenAI model";
  static readonly VOICE_INSTRUCTIONS_LABEL = "Voice chat instructions";
  static readonly VOICE_INSTRUCTIONS_HELP = "Optional. Replaces the built-in voice chat rules. The project list, the rule for suggesting changes and the rule against patient details are always added. Up to 4,000 characters.";
  static readonly VOICE_INSTRUCTIONS_TOO_LONG = "Voice chat instructions can be up to 4,000 characters.";
  static readonly VOICE_INSTRUCTIONS_SAVED = "Voice chat instructions saved.";
  static readonly VOICE_INSTRUCTIONS_SAVE = "Save instructions";
  /** "3 voice models listed", "1 chat model listed". */
  static modelsListed(n: number, kindLabel: string): string {
    return `${n} ${kindLabel.toLowerCase()} ${n === 1 ? "model" : "models"} listed`;
  }
  static readonly MODEL_ADD_PLACEHOLDER = "For example gpt-example-mini";
  /** Typed-ID placeholder for the voice chat model (a realtime example, not a chat model). */
  static readonly VOICE_MODEL_PLACEHOLDER = "For example, gpt-example-realtime";
  static readonly MODEL_ADD_HELP = "Checked against OpenAI's model list with the saved API key. It starts off.";
  static readonly MODEL_ADD = "Add model";
  static readonly MODEL_ADDING = "Checking…";
  static readonly MODEL_ID_INVALID = "Enter a model name using letters, numbers, dots, dashes or underscores";
  static readonly MODEL_EXISTS = "That model is already in the list";
  static readonly MODEL_NOT_FOUND = "OpenAI doesn't list that model for the saved API key";
  static readonly MODEL_CHECK_NEEDS_KEY = "Save OpenAI as the provider with an API key first, so the model can be checked";
  static readonly MODEL_CHECK_FAILED = "Couldn't reach OpenAI to check the model. Try again.";
  static readonly MODEL_WRONG_KIND = "That model doesn't fit this feature. Choose one from the list.";
  static readonly MODEL_LIST_LOAD = "Show OpenAI models";
  static readonly MODEL_LIST_LOADING = "Loading…";
  static readonly MODEL_LIST_HELP = "Models OpenAI lists for the saved API key. Adding one doesn't turn it on.";
  static readonly MODEL_LIST_EMPTY = "OpenAI listed no chat, transcription or voice models for this key.";
  static readonly MODEL_ADD_MANUAL_HELP = "The model list didn't load, so this ID is saved without checking. It starts off.";
  static readonly MODEL_LIST_ADDED = "Added";
  static readonly MODEL_KIND_LABEL = "Type";
  static readonly PRICE_UNIT_NONE = "No price";
  static readonly PRICE_UNIT_PER_1M_TOKENS = "Per 1M tokens";
  static readonly PRICE_UNIT_PER_MINUTE = "Per minute";
  static readonly PRICE_SAVE = "Save prices";
  static readonly PRICES_SAVED = "Prices saved.";
  static readonly PRICE_INVALID = "Enter a price like 0.15, or leave it blank";
  static readonly PRICE_UNIT_REQUIRED = "Choose a price unit";

  // ---- Refresh prices (step 3c) ----------------------------------------------------------------------------------
  static readonly REFRESH_PRICES = "Refresh prices";
  static readonly REFRESHING_PRICES = "Reading OpenAI's pricing page…";
  static readonly REFRESH_PRICES_HELP = "Reads OpenAI's published pricing page and shows the changes for your models. Nothing is saved until you confirm.";
  static readonly PRICE_REVIEW_TITLE = "Review price changes";
  static readonly PRICE_REVIEW_INTRO = "Prices from OpenAI's pricing page for the models in your list. Prices are for reference only. Nothing is saved until you confirm.";
  static readonly PRICE_REVIEW_HEADERS = ["Model", "Current price", "New price", "Status"] as const;
  static readonly PRICE_REVIEW_CHANGED = "Changed";
  static readonly PRICE_REVIEW_SAME = "No change";
  static readonly PRICE_REVIEW_NOT_FOUND = "Not on the pricing page. Keeps the current price.";
  static readonly PRICE_REVIEW_NOT_LISTED = "No longer listed by OpenAI";
  static readonly PRICE_REVIEW_NEWLY_LISTED = "Listed by OpenAI but not in your list:";
  static readonly PRICE_REVIEW_LIST_UNCHECKED = "OpenAI's model list couldn't be checked, so listing changes aren't shown.";
  static readonly PRICE_REVIEW_NO_CHANGES = "Prices already match OpenAI's pricing page. Nothing to save.";
  static readonly PRICE_REVIEW_CONFIRM = "Confirm and save";
  static readonly PRICE_REVIEW_SOURCE = "Source:";
  static readonly PRICE_REFRESH_FETCH_FAILED = "Couldn't read OpenAI's pricing page. Nothing was changed. Try again later, or enter prices by hand.";
  static readonly PRICE_REFRESH_FORMAT_CHANGED = "OpenAI's pricing page changed format, so this app couldn't read it. Nothing was changed. Enter prices by hand.";
  static readonly PRICE_REFRESH_NO_MATCH = "None of your models are on OpenAI's pricing page. Nothing was changed.";
  static readonly PRICE_REFRESH_STALE = "Prices changed since you opened this review. Nothing was saved. Refresh again.";
  static readonly PRICE_REFRESH_OFF = "Refresh prices is turned off.";
  static readonly PRICE_SOURCE_MANUAL = "entered by hand";
  static readonly PRICE_SOURCE_REFRESHED = "from OpenAI's pricing page";
  static readonly PRICE_NEVER_UPDATED = "Prices not updated yet";
  static readonly PRICE_REFRESH_FIELD = "Price refresh";

  static priceRefreshError(reason: string): string {
    return reason === "fetch_failed" ? AiCopy.PRICE_REFRESH_FETCH_FAILED : reason === "no_match" ? AiCopy.PRICE_REFRESH_NO_MATCH : AiCopy.PRICE_REFRESH_FORMAT_CHANGED;
  }

  static pricesRefreshed(n: number): string {
    return n === 1 ? "Prices saved for 1 model." : `Prices saved for ${n} models.`;
  }

  /** Under each model name: "Prices updated Oct 15, 2026, from OpenAI's pricing page". */
  static priceUpdated(when: string, source: string | null | undefined): string {
    return `Prices updated ${when}, ${source === "refreshed" ? AiCopy.PRICE_SOURCE_REFRESHED : AiCopy.PRICE_SOURCE_MANUAL}`;
  }

  /** Money with at least two decimals: "0.1" -> "$0.10", "0.125" -> "$0.125", "5" -> "$5.00". */
  static money(v: string): string {
    const [whole, frac = ""] = v.trim().split(".");
    return `$${whole || "0"}.${frac.padEnd(2, "0")}`;
  }

  /** One price in the review and the change log: "$0.10 in, $0.50 out per 1M tokens", "$0.10 in per 1M tokens", "$0.05 per minute", "No price". */
  static priceSummary(unit: string | null, input: string, output: string): string {
    if (unit === "per_minute") return `${AiCopy.money(input)} per minute`;
    if (unit === "per_1m_tokens") return output === "" ? `${AiCopy.money(input)} in per 1M tokens` : `${AiCopy.money(input)} in, ${AiCopy.money(output)} out per 1M tokens`;
    return AiCopy.PRICE_UNIT_NONE;
  }
  static readonly DISABLE_CONFIRM_YES = "Turn off anyway";
  static readonly DISABLE_CONFIRM_NO = "Keep on";
  static readonly FEATURES_TITLE = "Features";
  static readonly FEATURES_INTRO = "Turn each AI feature on or off for everyone. Each one uses the model chosen above, except Dictation, which has its own model.";
  static readonly FEATURE_ON_HELP = "On for everyone.";
  static readonly FEATURE_OFF_HELP = "Off for everyone. The button is hidden.";
  static readonly FEATURE_REVISE_NOTE = "Revise with AI on the update note";

  static featureLabel(feature: string): string {
    return feature === "revise_note" ? AiCopy.FEATURE_REVISE_NOTE : (AiToolsCopy.FEATURE_LABELS[feature] ?? feature);
  }

  static featureKilled(envName: string): string {
    return `Turned off on the server by ${envName}. This toggle has no effect until that setting is removed.`;
  }

  static modelAdded(id: string): string {
    return `${id} added. It's off until you turn it on.`;
  }

  static disableWarning(id: string, features: readonly string[]): string {
    return `${id} is the model in use. Turning it off stops ${features.join(", ")}. Choose another model first, or turn it off anyway.`;
  }

  static priceUnitLabel(u: string | null): string {
    return u === "per_1m_tokens" ? AiCopy.PRICE_UNIT_PER_1M_TOKENS : u === "per_minute" ? AiCopy.PRICE_UNIT_PER_MINUTE : AiCopy.PRICE_UNIT_NONE;
  }
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
  static readonly PREVIEW_OFF = "AI is off on preview deployments.";

  /** The editor's "AI unavailable" message, or the preview one on a Vercel preview (no key is decrypted there). */
  static unavailable(env: Record<string, string | undefined> = process.env): string {
    return env.VERCEL_ENV === "preview" ? AiCopy.PREVIEW_OFF : AiCopy.UNAVAILABLE;
  }
  static readonly KEY_USE_PROVIDER_KEYS = "The OpenAI key is managed under Provider keys at the top of this page.";
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
  static readonly TEST_HELP = "Sends a short test prompt with the saved provider and API key, using the model picked here.";
  static readonly TEST_NEEDS_SETTINGS = "Save a provider and API key first.";
  static readonly TEST_FAILED_PREFIX = "Connection failed.";
  static readonly HISTORY_TITLE = "Change log";
  static readonly HISTORY_EMPTY = "No changes yet.";
  static readonly HISTORY_HEADERS = ["When", "Who", "Field", "Change"] as const;
  static readonly STATUS_READY = "Ready";
  static readonly STATUS_OFF = "Off";
  static readonly STATUS_NOT_READY = "Not ready";
  static readonly DB_MISSING = "The AI settings tables aren't in this database yet, so settings can't be saved here.";

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
      case "aiModel":
        return AiCopy.MODELS_TITLE;
      case "aiFeature":
        return AiCopy.FEATURES_TITLE;
      case "aiFeatureModel":
        return AiToolsCopy.DICTATION_MODEL_LABEL;
      case "aiPriceRefresh":
        return AiCopy.PRICE_REFRESH_FIELD;
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
    if (action === "model_added") return `${newValue ?? ""} added (off)`;
    if (action === "model_enabled") return `${newValue ?? ""} turned on`;
    if (action === "model_disabled") return `${newValue ?? ""} turned off`;
    if (action === "prices_refreshed") return newValue ? `Saved from OpenAI's pricing page. ${newValue}` : "Saved from OpenAI's pricing page.";
    if (action === "price_refresh_failed") return `Refresh failed, nothing changed (${newValue === "fetch_failed" ? "page couldn't be read" : newValue === "no_match" ? "no models matched" : "format changed"})`;
    if (action === "feature_on") return `${AiCopy.featureLabel(newValue ?? "")} turned on`;
    if (action === "feature_off") return `${AiCopy.featureLabel(newValue ?? "")} turned off`;
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
  /** Under Draft and Fit when the writing assistant is on but its model is turned off under Models (step 3b-2). */
  static readonly MODEL_OFF_NOTE = "Draft and Fit are paused because the AI model is turned off. An admin can turn one on in AI settings.";
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
  static readonly RATE_LIMITED = "Too many AI requests in the last minute. Wait a moment and try again.";
  static readonly PROVIDER_ERROR = "The AI service didn't respond. Your note is unchanged. Try again in a moment.";
  static readonly TIMEOUT = "The AI service took too long to respond. Your note is unchanged. Try again in a moment.";
  /** 200 with no text because the reply hit its token limit (reasoning models can spend it all thinking). */
  static readonly OUT_OF_REPLY_LENGTH = "The model used up its reply length before answering. Try again, or pick a smaller model.";
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

  // ---- Review-then-apply layer (Revise with AI) ------------------------------------------------------------------
  // Reused unchanged from the writing assistant above: PANEL_ORIGINAL, PANEL_NOTE, REFERENCE_LABEL, EDIT, WORKING,
  // PHI_HELPER, APPLIED_NOT_SAVED, UNDO, UNDONE, ACCEPT_BLOCKED, LEGEND_WORDS, LEGEND_NUMBERS, numberWarning,
  // RATE_LIMITED, PROVIDER_ERROR, TIMEOUT, OUT_OF_REPLY_LENGTH, UNAVAILABLE and MODEL_NOT_ALLOWED.
  static readonly REVISE_BUTTON = "Revise with AI";
  static readonly REVISE_TOOLTIP = "Describe a change to this update. You'll review the suggestion first, and nothing changes until you save the project.";
  static readonly INSTRUCTION_LABEL = "What should change?";
  static readonly INSTRUCTION_PLACEHOLDER = "For example: shorten it and say go-live moved to March";
  static readonly PROPOSE = "Propose change";
  static readonly REVIEW_TITLE = "Proposed change";
  static readonly YOUR_EDIT = "Your edit";
  static readonly APPLY = "Apply";
  static readonly REJECT = "Reject";
  static readonly CANCEL = "Cancel";
  static readonly REJECTED = "Suggestion rejected. Your note is unchanged.";
  static readonly INSTRUCTION_EMPTY = "Describe the change first.";
  static readonly AUDIO_UNSUPPORTED = "Dictation isn't available yet. Type the change instead.";
  static readonly FEATURE_OFF = "Revise with AI is turned off. Your note is unchanged.";
  static readonly APPLY_FAILED = "Couldn't apply the suggestion. Your note is unchanged. Try again.";
  /** The app's generic denials (same wording as the other project actions). */
  static readonly PROJECT_GONE = "This project was deleted or no longer exists.";
  static readonly NOT_AUTHORIZED = "Not authorized.";

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
