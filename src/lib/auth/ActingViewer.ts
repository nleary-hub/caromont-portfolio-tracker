import { AsyncLocalStorage } from "node:async_hooks";
import type { GateUser } from "@/lib/permissions/RoleResolver";

type Acting = GateUser & { name: string | null };

/**
 * The person a Claude connector request acts for, for the duration of that request only. The connector route sets it
 * (src/app/api/mcp) after verifying the connector token and re-resolving the person (McpViewer); CurrentViewer and
 * AdminGate read it before the session cookie. That lets the connector run the app's own Server Functions, with their
 * own permission checks, validation and history, exactly as if the person clicked the control themselves.
 *
 * Nothing else may call run(): it is only set inside the connector route. Outside a run() every read returns null,
 * so normal page and action requests are unchanged.
 */
export class ActingViewer {
  private static readonly store = new AsyncLocalStorage<Acting>();

  static run<T>(viewer: Acting, fn: () => Promise<T>): Promise<T> {
    return ActingViewer.store.run(viewer, fn);
  }

  static get(): Acting | null {
    return ActingViewer.store.getStore() ?? null;
  }
}
