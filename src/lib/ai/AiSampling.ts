/**
 * Which sampling fields a provider call may include.
 *
 * Anthropic's model-deprecations page (checked Nov 2026): on API version 2023-06-01, a non-default
 * `temperature`, `top_p`, or `top_k` returns HTTP 400 ("`temperature` is deprecated for this model")
 * for Claude 4.7 and later and for Claude Mythos. Older Claude models still accept temperature.
 * API version 2026-10-21 rejects those fields on every model; this app stays on 2023-06-01 and omits
 * the field only for models that reject it. A 400 that names a sampling field is retried once without it,
 * so a model this list doesn't know yet is not sent a parameter it has just refused.
 */
export class AiSampling {
  static readonly TEMPERATURE = 0.2;
  /** Fields a provider may reject. Only these are ever stripped, and only when the error names them. */
  static readonly OPTIONAL = ["temperature", "top_p", "top_k", "reasoning_effort"] as const;

  /** Claude generation from an API id, ignoring an 8-digit date suffix. Null when it isn't a Claude id. */
  static claudeGeneration(model: string): { major: number; minor: number } | null {
    const id = model.trim().toLowerCase();
    if (!id.startsWith("claude")) return null;
    const nums = id
      .split(/[^a-z0-9]+/)
      .filter((p) => /^\d+$/.test(p) && p.length < 8)
      .map((p) => Number(p));
    if (!nums.length) return null;
    return { major: nums[0], minor: nums.length > 1 ? nums[1] : 0 };
  }

  /** True when this Anthropic model rejects a non-default temperature on every API version. */
  static anthropicOmitsTemperature(model: string): boolean {
    const id = model.trim().toLowerCase();
    if (id.includes("mythos")) return true;
    const g = AiSampling.claudeGeneration(model);
    if (!g) return false;
    return g.major > 4 || (g.major === 4 && g.minor >= 7);
  }

  /** Sampling fields for an Anthropic Messages body. Empty when the model rejects them. */
  static anthropic(model: string): { temperature?: number } {
    return AiSampling.anthropicOmitsTemperature(model) ? {} : { temperature: AiSampling.TEMPERATURE };
  }

  /**
   * A copy of `body` without sampling fields the error says this model rejected.
   * Null when nothing in the body matches, so the caller does not retry a different failure.
   */
  static withoutRejected(body: Record<string, unknown>, errorText: string): Record<string, unknown> | null {
    const text = errorText.toLowerCase();
    if (!/deprecat|unsupported|not supported|unknown parameter|unexpected/.test(text)) return null;
    const drop = AiSampling.OPTIONAL.filter((k) => k in body && text.includes(k));
    if (!drop.length) return null;
    const next = { ...body };
    for (const k of drop) delete next[k];
    return next;
  }
}
