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
