import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, SIGN_IN_PATH } from "@/auth";
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
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-6 shadow-lg">
        <h1 className="type-title">{PasswordCopy.SET_TITLE}</h1>
        <p className="mt-1 type-caption text-muted">{PasswordCopy.SET_INTRO}</p>
        <p className="mt-3 type-table text-muted">{email}</p>
        <SetPasswordForm email={email} />
      </div>
    </main>
  );
}
