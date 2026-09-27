"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ServiceLineForms, type ServiceLineActionResult } from "@/lib/services/ServiceLineForms";

/** Service line admin actions. Each re-checks admin (ServiceLineForms and ServiceLineService check again). */
class ServiceLineRevalidate {
  static after(result: ServiceLineActionResult): ServiceLineActionResult {
    // The active line shapes every page (top bar, dashboard, admin pages), so refresh the whole layout.
    if (result.ok) revalidatePath("/", "layout");
    return result;
  }
}

export async function saveServiceLine(input: { id?: string; name: string; shortName: string }): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.save(await CurrentViewer.get(), input));
}

export async function archiveServiceLine(id: string): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.archive(await CurrentViewer.get(), id));
}

export async function unarchiveServiceLine(id: string): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.unarchive(await CurrentViewer.get(), id));
}

export async function deleteServiceLine(id: string, confirmName: string): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.remove(await CurrentViewer.get(), id, confirmName));
}

export async function restoreServiceLine(id: string): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.restore(await CurrentViewer.get(), id));
}

export async function switchServiceLine(id: string): Promise<ServiceLineActionResult> {
  return ServiceLineRevalidate.after(await ServiceLineForms.switchTo(await CurrentViewer.get(), id));
}
