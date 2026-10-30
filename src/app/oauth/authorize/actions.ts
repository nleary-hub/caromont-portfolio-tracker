"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { McpOAuth } from "@/lib/mcp/McpOAuth";
import { McpTokens } from "@/lib/mcp/McpTokens";

/** The query the consent form carries back. Everything is checked again here; the hidden fields are never trusted. */
const FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

async function originOf(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return McpOAuth.origin(`${proto}://${host}/`);
}

/** Approve or deny a Claude connector request. Only the signed-in person can approve, and only for themself. */
export async function decideConnectorAccess(formData: FormData): Promise<void> {
  if (!McpOAuth.enabled()) redirect("/");
  const viewer = await CurrentViewer.get();
  if (!viewer) redirect("/signin");
  const params: Record<string, string | undefined> = {};
  for (const f of FIELDS) {
    const v = formData.get(f);
    if (typeof v === "string" && v !== "") params[f] = v;
  }
  const origin = await originOf();
  const key = McpTokens.key();
  const checked = McpOAuth.checkAuthorize(params, key, origin);
  if (!checked.ok) {
    if ("redirect" in checked) redirect(checked.redirect);
    redirect("/");
  }
  if (formData.get("decision") !== "approve") redirect(McpOAuth.deny(checked.request, origin));
  console.info("Claude connector approved", { client: checked.request.clientName });
  redirect(McpOAuth.approve(checked.request, viewer.email, key!, origin));
}
