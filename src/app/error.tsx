"use client";

import { useEffect } from "react";
import { reportClientError } from "@/components/ClientErrorReporter";

/** Route error boundary: reports the error (scrubbed) and offers a retry. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportClientError("boundary", error), [error]);
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <h1 className="type-heading">Something went wrong</h1>
      <p className="text-muted type-table">This page hit an error. It has been reported.</p>
      <button type="button" onClick={reset} className="h-8 rounded-control bg-accent-strong px-3.5 text-white type-table-strong">
        Try again
      </button>
    </main>
  );
}
