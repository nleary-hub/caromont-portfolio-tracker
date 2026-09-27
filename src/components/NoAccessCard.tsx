import Link from "next/link";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";

/**
 * Centered card on a blank page (no top bar, switcher or counts) for a signed-in person who may not see what they
 * asked for: no line at all, or a linked line they lack (then `line` names it and `goTo` is their first line).
 * Server component: nothing about any other line is sent to the browser.
 */
export function NoAccessCard({
  email,
  signOutAction,
  line,
  goTo,
}: {
  email: string;
  signOutAction: () => Promise<void>;
  line?: string;
  goTo?: { shortName: string; href: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6" data-testid="no-access">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-6 text-center shadow-lg">
        <p className="type-label text-muted uppercase">Service Line Portfolio Tracker</p>
        <h1 className="mt-3 type-title">{line ? LineAccessCopy.lineTitle(line) : LineAccessCopy.NO_ACCESS_TITLE}</h1>
        <p className="mt-2 type-body text-muted">{line ? LineAccessCopy.LINE_BODY : LineAccessCopy.NO_ACCESS_BODY}</p>
        {goTo && (
          <Link href={goTo.href} className="mt-5 inline-flex h-8 items-center rounded-control bg-accent px-3.5 text-white type-table-strong hover:opacity-90">
            {LineAccessCopy.goTo(goTo.shortName)}
          </Link>
        )}
        <p className="mt-5 type-caption text-muted" data-testid="no-access-email">
          {LineAccessCopy.signedInAs(email)}
        </p>
        <form action={signOutAction} className="mt-1">
          <button type="submit" className="type-table-strong text-accent hover:underline">
            {LineAccessCopy.SIGN_OUT}
          </button>
        </form>
      </div>
    </main>
  );
}
