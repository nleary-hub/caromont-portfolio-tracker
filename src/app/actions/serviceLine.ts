"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ServiceLineForm, type ServiceLineFormState } from "@/lib/services/ServiceLineForm";

/** Admin "Service line" settings. Re-checks admin itself (ServiceLineForm and ServiceLineService check again). */
export async function saveServiceLine(_prev: ServiceLineFormState, form: FormData): Promise<ServiceLineFormState> {
  const state = await ServiceLineForm.submit(await CurrentViewer.get(), { name: form.get("name"), shortName: form.get("shortName") });
  if (state?.ok) revalidatePath("/", "layout");
  return state;
}
