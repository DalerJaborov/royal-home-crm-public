import { useState } from "react";

export type RouteViewportIdentity = { pathname: string; generation: number };

/** Appearance changes must not discard a form on the current route. */
export function nextRouteViewportIdentity(previous: RouteViewportIdentity, pathname: string, clean: boolean): RouteViewportIdentity {
  if (previous.pathname === pathname) return previous;
  return { pathname, generation: previous.generation + (clean ? 0 : 1) };
}

export function useRouteViewportKey(pathname: string, clean: boolean): number {
  const [identity, setIdentity] = useState<RouteViewportIdentity>(() => ({ pathname, generation: 0 }));
  const next = nextRouteViewportIdentity(identity, pathname, clean);
  // Adjust before children commit: legacy route changes still reset page state,
  // while Clean navigation retains its existing persistent Suspense boundary.
  if (next !== identity) setIdentity(next);
  return next.generation;
}
