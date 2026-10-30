import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AuthMessageIcon, AuthStage } from "@/components/AuthStage";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { McpOAuth } from "@/lib/mcp/McpOAuth";
import { McpTokens } from "@/lib/mcp/McpTokens";
import { decideConnectorAccess } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Consent screen for the Claude connector (OAuth authorize endpoint). The proxy has already required sign-in, so this
 * page only ever approves access for the person who is signed in, with their own role and service line access.
 */
export default async function ConnectorAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!McpOAuth.enabled()) notFound();
  const raw = await searchParams;
  const params: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) params[k] = Array.isArray(v) ? v[0] : v;

  const viewer = await CurrentViewer.get();
  if (!viewer) redirect("/signin");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  const origin = McpOAuth.origin(`${proto}://${host}/`);
  const checked = McpOAuth.checkAuthorize(params, McpTokens.key(), origin);
  if (!checked.ok && "redirect" in checked) redirect(checked.redirect);

  return (
    <AuthStage state={checked.ok ? undefined : "error"}>
      {!checked.ok ? (
        <p role="alert" className="si-error" data-testid="connector-error">
          <AuthMessageIcon kind="alert" />
          <span>{checked.message}</span>
        </p>
      ) : (
        <form action={decideConnectorAccess} className="space-y-4" data-testid="connector-consent">
          <div className="space-y-2">
            <p className="type-body">
              <strong>{checked.request.clientName}</strong> wants to connect to the Service Line Portfolio as <strong>{viewer.email}</strong>.
            </p>
            <p className="type-caption text-muted">
              It will be able to read and change projects you can change, with your role and service line access. Its edits show in each project&apos;s
              History as &ldquo;Claude connector&rdquo;. You can disconnect it in Claude at any time; an admin turning your sign-in off stops it too.
            </p>
            {checked.request.scopes.includes("admin") && (
              <p className="type-caption text-muted" data-testid="connector-admin-scope">
                <strong>Admin tasks:</strong> it will also be able to do what your role allows on the admin screens: departments and name lists, people,
                sign-in on or off, service line and department access, roles and permissions, templates, service lines, settings and layout, report options,
                hiding, deleting and restoring projects, and CSV import. Big changes ask you first. It can&apos;t see or set passwords or AI keys.
              </p>
            )}
          </div>
          {Object.entries(params)
            .filter(([k]) => ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"].includes(k))
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v ?? ""} />
            ))}
          <div className="space-y-2">
            <button type="submit" name="decision" value="approve" className="si-btn si-btn-primary" data-testid="connector-approve">
              <span className="si-btn-label">Allow access</span>
            </button>
            <button type="submit" name="decision" value="deny" className="si-btn si-btn-secondary" data-testid="connector-deny">
              <span className="si-btn-label">Cancel</span>
            </button>
          </div>
        </form>
      )}
    </AuthStage>
  );
}
