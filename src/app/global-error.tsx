"use client";

import { useEffect } from "react";
import { reportClientError } from "@/components/ClientErrorReporter";

/** Root error boundary (the layout itself failed): reports the error (scrubbed) and offers a retry. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportClientError("boundary", error), [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", background: "#0f1115", color: "#e6e6e6", padding: 32 }}>
        <h1>Something went wrong</h1>
        <p>This page hit an error. It has been reported.</p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}
