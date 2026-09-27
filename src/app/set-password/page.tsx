import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, SIGN_IN_PATH } from "@/auth";
import { AuthStage } from "@/components/AuthStage";
import { SetPasswordForm } from "@/components/SetPasswordForm";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { SessionAccess } from "@/lib/auth/SessionAccess";

export const metadata: Metadata = { title: PasswordCopy.SET_TITLE };
export const dynamic = "force-dynamic";

/**
 * First sign-in with a temporary password: the only page such a session can reach (the proxy sends everything here).
 * Every password sign-in lands here first (?next= is where they were going); anyone else is sent straight on.
 */
export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await auth();
  if (!SessionAccess.allowed(session)) redirect(SIGN_IN_PATH);
  if (!SessionAccess.mustChangePassword(session)) redirect(SessionAccess.safeNext((await searchParams).next));
  const email = SessionAccess.email(session)!;
  return (
    // Same frame as /signin (the headline is the page's h1, so the card title is an h2).
    <AuthStage>
      <div className="si-reveal si-d1">
        <h2 className="type-title text-fg">{PasswordCopy.SET_TITLE}</h2>
        <p className="mt-1 type-caption text-muted">{PasswordCopy.SET_INTRO}</p>
        <p className="mt-3 type-table text-muted">{email}</p>
      </div>
      <SetPasswordForm email={email} />
    </AuthStage>
  );
}
