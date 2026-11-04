import { FREEZE_DISABLED_BUTTON, FreezeDisabledNote } from "@/components/FreezeDisabledNote";
import { DriveConnectText, type DriveConnectMessage } from "@/lib/report/DriveConnectText";

/**
 * Admin > Report freeze, Owner only: a plain form POST to /api/drive/connect, which sends the Owner to Google to renew
 * the app's Drive access (DriveOAuth). Secondary button like Check Drive. `message`: the result after Google sends the
 * Owner back (?drive=). `connectedNote`: when Drive was last connected in the app. `redirectNote`: the callback address Google must allow. `disabledNote`: preview deployments.
 */
export function ReconnectDriveButton({ message = null, connectedNote = null, redirectNote = null, disabledNote = null }: { message?: DriveConnectMessage | null; connectedNote?: string | null; redirectNote?: string | null; disabledNote?: string | null }) {
  return (
    <div className="flex flex-col gap-1" data-testid="drive-reconnect-block">
      <form method="post" action={DriveConnectText.CONNECT_PATH} className="flex flex-wrap items-center gap-3 type-table">
        <button
          type="submit"
          disabled={disabledNote !== null}
          className={`h-8 rounded-control border border-line bg-card px-3.5 text-muted type-table-strong hover:text-fg ${FREEZE_DISABLED_BUTTON}`}
          data-testid="drive-reconnect"
        >
          {DriveConnectText.LABEL}
        </button>
        {disabledNote !== null && <FreezeDisabledNote note={disabledNote} testId="drive-reconnect-disabled-note" />}
        {disabledNote === null && connectedNote && <span className="text-muted type-caption" data-testid="drive-connected-note">{connectedNote}</span>}
      </form>
      <p className={disabledNote !== null ? "text-muted type-caption opacity-60" : "text-muted type-caption"}>{DriveConnectText.HELP}</p>
      {redirectNote && disabledNote === null && <p className="text-muted type-caption break-all" data-testid="drive-redirect-note">{redirectNote}</p>}
      {message && (
        <p role="status" data-testid="drive-reconnect-result" className={`type-table ${message.ok ? "text-(--status-on-track-dark-fg)" : "text-danger"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
