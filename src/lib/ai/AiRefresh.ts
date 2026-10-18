/**
 * Item C: after an AI apply or undo, the dashboard refreshes live. Panels call notify(); AiRefreshListener (mounted
 * once in the root layout) runs router.refresh(). A plain DOM event keeps the panels free of router hooks.
 */
export class AiRefresh {
  static readonly EVENT = "tracker:ai-applied";

  static notify(): void {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(AiRefresh.EVENT));
  }
}
