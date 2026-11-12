import type { AiCallResult } from "./AiProviderClient";
import type { AiProviderId } from "./AiProviders";

/** ai_fallback_event.triggerClass values this alert writes (0071 DB check). Configuration faults are never written here. */
export type AiFailureClass = "network" | "timeout" | "http_5xx" | "http_429" | "key_rejected" | "model_gone" | "billing_quota";

/** ai_fallback_event.primaryProvider values (0071 DB check). */
export type AiFailureProvider = "openai" | "anthropic" | "xai" | "other";

type Failure = Extract<AiCallResult, { ok: false }>;

/** Copy for the Admin AI failure banner and the error a person sees when trying again won't help. */
export const AiFailureCopy = {
  /** Writing assistant and Revise with AI: the model can't be used (gone, key refused, out of credit). */
  NOT_USABLE_NOTE: "The AI model couldn't be used, so trying again won't help yet. Your note is unchanged. An admin can see what failed at the top of Admin > AI settings.",
  /** AI tools: the same, without "note". */
  NOT_USABLE_TOOL: "The AI model couldn't be used, so trying again won't help yet. Nothing was changed. An admin can see what failed at the top of Admin > AI settings.",
  title(count: number): string {
    return count === 1 ? "An AI call failed since this was last marked as seen" : `AI calls failed ${count} times since this was last marked as seen`;
  },
  HELP: "No other model was used. Each person saw an error and their text was left unchanged.",
  MORE: "and more",
  ACK: "Mark as seen",
  ACKING: "Marking…",
  ACK_FAILED: "Couldn't mark these as seen. Try again.",
  PREVIEW: "Read-only on a preview.",
  REASONS: {
    timeout: "took too long to answer",
    network: "couldn't be reached",
    http_5xx: "had a server error on the provider's side",
    http_429: "was too busy (rate limited)",
    key_rejected: "refused the API key",
    model_gone: "says the model is gone or retired",
    billing_quota: "is out of credit or quota",
  } satisfies Record<AiFailureClass, string>,
  line(args: { model: string; category: string; reason: AiFailureClass; count: number; last: string }): string {
    const times = args.count === 1 ? "once" : `${args.count} times`;
    return `${args.model} (${args.category}) ${AiFailureCopy.REASONS[args.reason]}: ${times}, last ${args.last}.`;
  },
} as const;

/**
 * Pure rules for the "alert only" fallback choice (Nov 12): which failed AI calls are worth an admin's attention, and
 * how they are recorded. No model is ever switched. Classes and numbers only: never a prompt, reply or provider message.
 */
export class AiFailureAlert {
  /** The 0071 model-id check, so a row never fails the DB constraint. */
  static readonly MODEL_SHAPE = /^[A-Za-z0-9._:/-]{1,200}$/;
  private static readonly QUOTA = /quota|credit balance|billing|insufficient[_ ]funds|payment required/i;
  private static readonly MODEL_GONE = /model[^.]{0,120}(not found|does not exist|not exist|deprecated|decommissioned|retired|no longer (available|supported)|not supported)|model_not_found|not_found_error/i;

  /**
   * What kind of failure this is, or null when it isn't a provider failure an admin can act on (an empty reply, a reply
   * cut off by its length limit, a model turned off under Models, or another 4xx such as a bad request).
   */
  static classify(r: Failure): AiFailureClass | null {
    if (r.kind === "timeout") return "timeout";
    if (r.kind === "network") return "network";
    if (r.kind !== "http" || typeof r.status !== "number") return null;
    const s = r.status;
    const msg = r.message ?? "";
    if (s === 402) return "billing_quota";
    if (s === 429) return AiFailureAlert.QUOTA.test(msg) ? "billing_quota" : "http_429";
    if (s >= 500 && s <= 599) return "http_5xx";
    if (s === 401 || s === 403) return AiFailureAlert.QUOTA.test(msg) ? "billing_quota" : "key_rejected";
    if (s === 404 || s === 410) return "model_gone";
    if (s === 400) {
      if (AiFailureAlert.MODEL_GONE.test(msg)) return "model_gone";
      if (AiFailureAlert.QUOTA.test(msg)) return "billing_quota";
    }
    return null;
  }

  /** Failures that trying again in a moment won't fix: the person is told so, instead of "try again". */
  static notRetryable(c: AiFailureClass | null): boolean {
    return c === "model_gone" || c === "key_rejected" || c === "billing_quota";
  }

  /** The registry's provider name for a call's connection: Azure and custom endpoints are "other". */
  static providerOf(p: AiProviderId): AiFailureProvider {
    return p === "openai" || p === "anthropic" ? p : "other";
  }

  /** An HTTP status that fits the DB check (100..599), else null. */
  static statusOf(r: Failure): number | null {
    return r.kind === "http" && typeof r.status === "number" && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : null;
  }
}
