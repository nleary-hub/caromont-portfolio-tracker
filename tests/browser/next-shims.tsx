import { lazy, Suspense, type ComponentType, type AnchorHTMLAttributes } from "react";

// Only Next routing/code splitting is adapted for the standalone component harness.
// Every dashboard, drawer, editor and history component is the real application implementation.
export function dynamic(load: () => Promise<ComponentType<Record<string, unknown>>>) {
  const Component = lazy(async () => ({ default: await load() }));
  return function Dynamic(props: Record<string, unknown>) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>;
  };
}
export function Link(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} />; }
// next/navigation (year-end report button): the harness has no router, so refresh and navigation do nothing.
export function useRouter() { return { refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }; }
export function usePathname() { return "/"; }
