"use client";

import { createContext, createElement, useContext, useState, useTransition, type ReactNode } from "react";
import { listOpenAiModels } from "@/app/actions/aiAdmin";
import type { AiListedModel } from "@/lib/ai/AiModelKinds";

export type OpenAiListState = { ok: true; models: AiListedModel[] } | { ok: false; error: string } | null;
export type OpenAiModelList = { list: OpenAiListState; loading: boolean; load: () => void; shared: boolean };

const Shared = createContext<OpenAiModelList | null>(null);

function useLocalList(initial: OpenAiListState, shared: boolean): OpenAiModelList {
  const [list, setList] = useState<OpenAiListState>(initial);
  const [loading, start] = useTransition();
  const load = () => start(async () => setList(await listOpenAiModels()));
  return { list, loading, load, shared };
}

/**
 * One OpenAI model list for the whole Admin > AI settings page: the Models panel and every picker read and load the
 * same state, so a failed load is reported once (at the top of the AI settings card).
 */
export function OpenAiModelListProvider({ initial = null, children }: { initial?: OpenAiListState; children?: ReactNode }) {
  const value = useLocalList(initial, true);
  return createElement(Shared.Provider, { value }, children);
}

/**
 * OpenAI's /v1/models list for the saved key (#63's listOpenAiModels), loaded on demand. Uses the page's shared list
 * when inside OpenAiModelListProvider, otherwise its own. Read-only: nothing is added or turned on.
 */
export function useOpenAiModelList(initial: OpenAiListState = null): OpenAiModelList {
  const shared = useContext(Shared);
  const local = useLocalList(initial, false);
  return shared ?? local;
}
