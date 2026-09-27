"use client";

import { usePathname } from "next/navigation";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AdminMenu, MenuKeyboard, type AdminMenuIcon, type AdminMenuItem } from "@/lib/admin/AdminMenu";

/** 16px line icons for the admin menu (stroke = currentColor). */
class AdminMenuIcons {
  private static readonly PATHS: Record<AdminMenuIcon | "gear", ReactNode> = {
    gear: (
      <>
        <circle cx="8" cy="8" r="2.25" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
        <circle cx="8" cy="8" r="4.6" />
      </>
    ),
    upload: <path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v3h11v-3" />,
    file: <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8.5h4M6 11h4" />,
    download: <path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10.5v3h11v-3" />,
    pdf: <path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 9h1.2a1 1 0 010 2H6V8M9.5 11V8h1.5" />,
    archive: <path d="M1.5 3h13v3h-13zM2.5 6v7.5h11V6M6.5 8.5h3" />,
    snowflake: <path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5M6.5 2.5L8 4l1.5-1.5M6.5 13.5L8 12l1.5 1.5" />,
    template: <path d="M2 2h12v12H2zM2 6h12M6 6v8" />,
    departments: <path d="M2 2.5h12v3H2zM2 7h12v3H2zM2 11.5h12v2.5H2z" />,
    people: <path d="M6 7.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 7.5a2 2 0 100-4M12 10c1.5.4 2.5 1.7 2.5 4" />,
    audit: <path d="M3 1.5h10v13H3zM5.5 5h5M5.5 8h5M5.5 11h3" />,
    tag: <path d="M1.5 2.5v5l7 7 6-6-7-7h-5zM4.5 5.5h.01" />,
    settings: <path d="M2 4h7M12 4h2M2 12h2M7 12h7M9 2.5v3M5 10.5v3M11 4a1 1 0 11-2 0 1 1 0 012 0zM6 12a1 1 0 11-2 0 1 1 0 012 0z" />,
  };

  static of(name: AdminMenuIcon | "gear"): ReactNode {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {AdminMenuIcons.PATHS[name]}
      </svg>
    );
  }
}

/**
 * Admin-only menu button for the top bar (design: Figma Bro admin menu spec).
 * Only rendered when the server decided the viewer is an admin (`AdminMenu.itemsFor`); non-admins get no markup.
 * Keyboard: Enter / Space / ArrowDown open (first item), ArrowUp opens (last item), arrows / Home / End move,
 * Esc closes and returns focus to the button, Tab closes. Outside click closes.
 */
export function AdminMenuButton({ items, initialOpen = false }: { items: AdminMenuItem[]; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [focusIndex, setFocusIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const menuId = useId();
  const pathname = usePathname();
  const currentId = AdminMenu.currentId(items, pathname);
  const groups = AdminMenu.grouped(items);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && focusIndex >= 0) itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    setFocusIndex(-1);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
      return;
    }
    const target = MenuKeyboard.openFocus(e.key, flat.length);
    if (target === null) return;
    e.preventDefault();
    setOpen(true);
    setFocusIndex(target);
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const next = MenuKeyboard.move(focusIndex, e.key, flat.length);
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
  };

  const onItemClick = (item: AdminMenuItem, e: React.MouseEvent<HTMLAnchorElement>) => {
    if (item.kind === "viewSettings" && pathname === "/") {
      e.preventDefault();
      window.dispatchEvent(new Event(AdminMenu.OPEN_VIEW_SETTINGS_EVENT));
    }
    close(false);
  };

  return (
    <div ref={rootRef} className="am-root">
      <button
        ref={buttonRef}
        type="button"
        className="am-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close(false);
          else {
            setOpen(true);
            setFocusIndex(-1);
          }
        }}
        onKeyDown={onButtonKeyDown}
      >
        {AdminMenuIcons.of("gear")}
        Admin
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label="Admin" className="am-menu" onKeyDown={onMenuKeyDown}>
          {groups.map((g, gi) => (
            <Fragment key={g.group}>
              {gi > 0 && <div role="separator" className="am-divider" />}
              {g.items.map((item) => {
                const i = flat.indexOf(item);
                const current = item.id === currentId;
                return (
                  <a
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    role="menuitem"
                    tabIndex={-1}
                    href={item.href}
                    {...(item.kind === "download" || item.kind === "action" ? { download: "" } : {})}
                    aria-current={current ? "page" : undefined}
                    data-current={current ? "true" : undefined}
                    className="am-item"
                    onClick={(e) => onItemClick(item, e)}
                    onMouseEnter={() => setFocusIndex(i)}
                  >
                    {AdminMenuIcons.of(item.icon)}
                    <span className="am-label">{item.label}</span>
                    {item.caption && <span className="am-caption">{item.caption}</span>}
                  </a>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
