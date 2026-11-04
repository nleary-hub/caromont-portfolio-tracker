import Link from "next/link";
import { SIGN_IN_PATH } from "@/auth";
import { PublicPages, type PublicPage } from "@/lib/legal/PublicPages";

/** About, Privacy and Terms: public pages (no sign-in) that read the same way, with links between them. */
export function PublicDocPage({ page }: { page: PublicPage }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10" data-testid={`public-page-${page.path.slice(1)}`}>
      <header className="flex flex-col gap-2">
        <p className="type-caption text-muted">{PublicPages.APP_NAME}</p>
        <h1 className="type-title">{page.title}</h1>
        {page.path !== PublicPages.ABOUT.path && <p className="type-caption text-muted">Last updated {PublicPages.UPDATED}</p>}
        <p className="type-body">{page.intro}</p>
      </header>
      {page.sections.map((s) => (
        <section key={s.heading} className="flex flex-col gap-2">
          <h2 className="type-heading">{s.heading}</h2>
          {s.paragraphs.map((p) => (
            <p key={p} className="type-body">
              {p}
            </p>
          ))}
        </section>
      ))}
      <PublicLinks current={page.path} />
    </main>
  );
}

/** The footer links: the other public pages, then sign-in. */
export function PublicLinks({ current }: { current?: string }) {
  const links = [
    { href: PublicPages.ABOUT.path, label: "About" },
    { href: PublicPages.PRIVACY.path, label: "Privacy policy" },
    { href: PublicPages.TERMS.path, label: "Terms of service" },
    { href: SIGN_IN_PATH, label: "Sign in" },
  ].filter((l) => l.href !== current);
  return (
    <nav aria-label="About this app" className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-4 type-caption">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="text-muted underline-offset-2 hover:text-fg hover:underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
