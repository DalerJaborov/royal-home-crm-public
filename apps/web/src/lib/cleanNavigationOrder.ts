import type { NavItem } from "./navigation";
import { readCleanNavigationOrder } from "./cleanNavigationPreference";
export { readCleanNavigationOrder } from "./cleanNavigationPreference";

const PRIORITY = ["/", "/clients", "/messages", "/properties", "/deals", "/finance"];

export function defaultCleanNavigation(main: NavItem[], all: NavItem[]) {
  const registry = new Map(all.map((item) => [item.to, item]));
  const paths = [...new Set([...PRIORITY, ...main.map((item) => item.to), ...all.map((item) => item.to)])];
  return paths.flatMap((path) => {
    const item = registry.get(path);
    return item ? [{ ...item, label: path === "/" ? "Сегодня" : path === "/finance" ? "Деньги" : path === "/messages" ? "Чаты" : item.label }] : [];
  });
}

export function orderedCleanNavigation(main: NavItem[], all: NavItem[], saved: unknown) {
  const defaults = defaultCleanNavigation(main, all);
  const registry = new Map(defaults.map((item) => [item.to, item]));
  const stored = readCleanNavigationOrder(saved);
  const paths = [...new Set([...stored, ...defaults.map((item) => item.to)])];
  return paths.flatMap((path) => registry.has(path) ? [registry.get(path)!] : []);
}

export function partitionCleanNavigation(main: NavItem[], all: NavItem[], capacity = 6, saved: unknown = []) {
  const order = readCleanNavigationOrder(saved);
  const ordered = orderedCleanNavigation(main, all, order);
  const defaultTabPaths = new Set([...PRIORITY, ...main.map((item) => item.to)]);
  const candidates = order.length ? ordered : ordered.filter((item) => defaultTabPaths.has(item.to));
  const tabs = candidates.slice(0, Math.max(0, capacity));
  const visible = new Set(tabs.map((item) => item.to));
  // Preserve the approved default overflow ordering until the user customizes it.
  return { tabs, overflow: order.length ? ordered.slice(tabs.length) : all.filter((item) => !visible.has(item.to)) };
}

export function moveCleanNavigation(order: readonly string[], id: string, target: string) {
  const from = order.indexOf(id), to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Keep unavailable saved IDs dormant; losing a permission never deletes preferences. */
export function mergeCleanNavigationDraft(saved: readonly string[], visible: readonly string[], allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return readCleanNavigationOrder([...visible.filter((id) => allowedSet.has(id)), ...saved.filter((id) => !allowedSet.has(id))]);
}
