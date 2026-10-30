import { afterAll, beforeAll } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";

/**
 * Fictional contracts leads for tests. The live list stays in ServiceLine.CVPSL_CONTRACTS_LEADS (not changed by
 * tests); suites that run on that list swap in these names so no real person appears in a test. Same names, same
 * order as the 0016 seed.
 */
export const FICTIONAL_LEADS: readonly string[] = ["Avery Holt", "Jordan Pike", "Casey Lund", "Riley Moss", "Morgan Vale"];

export function useFictionalLeads(): void {
  let live: readonly string[];
  beforeAll(() => {
    live = ServiceLine.CVPSL_CONTRACTS_LEADS;
    Object.defineProperty(ServiceLine, "CVPSL_CONTRACTS_LEADS", { value: FICTIONAL_LEADS, writable: true, configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(ServiceLine, "CVPSL_CONTRACTS_LEADS", { value: live, writable: true, configurable: true });
  });
}
