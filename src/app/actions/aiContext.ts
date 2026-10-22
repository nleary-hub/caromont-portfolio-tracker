"use server";

import { revalidatePath } from "next/cache";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiGlossaryService, type GlossaryDb, type GlossaryResult } from "@/lib/services/AiGlossaryService";

/** Admin > AI settings > Context (item A). Each resolves the viewer from the session and re-checks admin. */
async function run(name: string, fn: (db: GlossaryDb, viewer: { email: string; isAdmin: boolean }) => Promise<GlossaryResult>): Promise<GlossaryResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  if (!Db.isConfigured()) return { ok: false, error: "Couldn't save. Try again." };
  try {
    const r = await fn(Db.client as unknown as GlossaryDb, viewer);
    if (r.ok) revalidatePath("/admin/ai");
    return r;
  } catch (e) {
    console.error(`Admin action failed: ${name}`, (e as Error)?.name);
    return { ok: false, error: "Couldn't save. Try again." };
  }
}

export async function addGlossaryTerm(term: string, definition: string): Promise<GlossaryResult> {
  return run("addGlossaryTerm", (db, v) => AiGlossaryService.addTerm(db, v, term, definition));
}

export async function setGlossaryDefinition(id: string, definition: string): Promise<GlossaryResult> {
  return run("setGlossaryDefinition", (db, v) => AiGlossaryService.setDefinition(db, v, id, definition));
}

export async function removeGlossaryTerm(id: string): Promise<GlossaryResult> {
  return run("removeGlossaryTerm", (db, v) => AiGlossaryService.removeTerm(db, v, id));
}

export async function setAiRoleTitle(title: string): Promise<GlossaryResult> {
  return run("setAiRoleTitle", (db, v) => AiGlossaryService.setRoleTitle(db, v, title));
}
