"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AiRefresh } from "@/lib/ai/AiRefresh";

/** Item C: re-reads the page's server data after an AI apply or undo (AiRefresh.notify), so the dashboard updates live. */
export function AiRefreshListener() {
  const router = useRouter();
  useEffect(() => {
    const on = () => router.refresh();
    window.addEventListener(AiRefresh.EVENT, on);
    return () => window.removeEventListener(AiRefresh.EVENT, on);
  }, [router]);
  return null;
}
