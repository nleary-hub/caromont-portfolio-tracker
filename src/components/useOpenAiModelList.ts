"use client";

import { useState, useTransition } from "react";
import { listOpenAiModels } from "@/app/actions/aiAdmin";
import type { AiListedModel } from "@/lib/ai/AiModelKinds";

export type OpenAiListState = { ok: true; models: AiListedModel[] } | { ok: false; error: string } | null;

/**
 * OpenAI's /v1/models list for the saved key (#63's listOpenAiModels), loaded on demand. Shared by the Models panel and
 * every model picker on Admin > AI settings, so they all read the same source. Read-only: nothing is added or turned on.
 */
export function useOpenAiModelList(initial: OpenAiListState = null) {
  const [list, setList] = useState<OpenAiListState>(initial);
  const [loading, start] = useTransition();
  const load = () => start(async () => setList(await listOpenAiModels()));
  return { list, loading, load };
}
