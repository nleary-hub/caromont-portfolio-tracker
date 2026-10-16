"use client";

import { useEffect } from "react";
import { ClientErrorScrub, type ClientErrorReport } from "@/lib/errors/ClientErrorScrub";

const PATH = "/api/client-errors";
const PER_PAGE = 10;
let sent = 0;

/** Posts one scrubbed report (message, stack, route). At most PER_PAGE per page load; never throws. */
export function reportClientError(kind: ClientErrorReport["kind"], err: unknown): void {
  try {
    if (typeof window === "undefined" || sent >= PER_PAGE) return;
    sent += 1;
    const body = JSON.stringify(ClientErrorScrub.fromThrown(kind, err, window.location.pathname));
    void fetch(PATH, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch {
    // Reporting must never cause another error.
  }
}

/** window.onerror and unhandledrejection to the server log. Mounted once in the root layout. */
export function ClientErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportClientError("error", e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => reportClientError("rejection", e.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
