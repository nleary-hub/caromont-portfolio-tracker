"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DepartmentForms, type AdminListResult } from "@/lib/services/DepartmentForms";

/** Departments and People admin actions. Each re-checks admin (DepartmentForms and the services check again). */
class DepartmentRevalidate {
  static after(result: AdminListResult): AdminListResult {
    // Departments shape the dashboard, filters, pick-lists and reports: refresh everything.
    if (result.ok) revalidatePath("/", "layout");
    return result;
  }
}

export async function saveDepartment(input: { id?: string; name: string; shortName: string }): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.save(await CurrentViewer.get(), input));
}

export async function reorderDepartments(ids: string[]): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.reorder(await CurrentViewer.get(), ids));
}

export async function archiveDepartment(id: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.archive(await CurrentViewer.get(), id));
}

export async function unarchiveDepartment(id: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.unarchive(await CurrentViewer.get(), id));
}

export async function deleteDepartment(id: string, confirmName: string, moveTo: string | null): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.remove(await CurrentViewer.get(), id, { confirmName, moveTo }));
}

export async function restoreDepartment(id: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.restore(await CurrentViewer.get(), id));
}

export async function addContractsLead(name: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.addContractsLead(await CurrentViewer.get(), name));
}

export async function removeContractsLead(name: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.removeContractsLead(await CurrentViewer.get(), name));
}

export async function addPerson(role: "owner" | "requester", name: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.addPerson(await CurrentViewer.get(), role, name));
}

export async function renamePerson(role: "owner" | "requester", name: string, newName: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.renamePerson(await CurrentViewer.get(), role, name, newName));
}

export async function removePerson(role: "owner" | "requester", name: string): Promise<AdminListResult> {
  return DepartmentRevalidate.after(await DepartmentForms.removePerson(await CurrentViewer.get(), role, name));
}
