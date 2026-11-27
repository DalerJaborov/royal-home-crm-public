import type { NavItem } from "./navigation";
import { readCleanNavigationOrder } from "./cleanNavigationPreference";
export { readCleanNavigationOrder } from "./cleanNavigationPreference";

const PRIORITY = ["/", "/clients", "/messages", "/properties", "/deals", "/finance"];
/**
 * Главные пункты бокового меню «Нового вида» — как в макете (27.11.2026, пачка shell2):
 * Сегодня, Клиенты, Чаты, Объекты, Деньги, Команда. Права те же: пункта, которого
 * у роли нет в реестре, нет и здесь, его место занимает следующий из её `main`.
 */
export const ROYAL_PRIORITY = ["/", "/clients", "/messages", "/properties", "/finance", "/team"];

export function defaultCleanNavigation(main: NavItem[], all: NavItem[], priority: readonly string[] = PRIORITY) {
  const registry = new Map(all.map((item) => [item.to, item]));
  const paths = [...new Set([...priority, ...main.map((item) => item.to), ...all.map((item) => item.to)])];
  return paths.flatMap((path) => {
    const item = registry.get(path);
    return item ? [{ ...item, label: path === "/" ? "Сегодня" : path === "/finance" ? "Деньги" : path === "/messages" ? "Чаты" : item.label }] : [];
  });
}

export function orderedCleanNavigation(main: NavItem[], all: NavItem[], saved: unknown, priority: readonly string[] = PRIORITY) {
  const defaults = defaultCleanNavigation(main, all, priority);
  const registry = new Map(defaults.map((item) => [item.to, item]));
  const stored = readCleanNavigationOrder(saved);
  const paths = [...new Set([...stored, ...defaults.map((item) => item.to)])];
  return paths.flatMap((path) => registry.has(path) ? [registry.get(path)!] : []);
}

export function partitionCleanNavigation(main: NavItem[], all: NavItem[], capacity = 6, saved: unknown = [], priority: readonly string[] = PRIORITY) {
  const order = readCleanNavigationOrder(saved);
  const ordered = orderedCleanNavigation(main, all, order, priority);
  const defaultTabPaths = new Set([...priority, ...main.map((item) => item.to)]);
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

/**
 * БОКОВОЕ МЕНЮ «НОВОГО ВИДА» (пачка B «одна оболочка», 20.11.2026).
 *
 * Было: шесть вкладок и под чертой ВЕСЬ остальной реестр плоским списком — у
 * директора 33 строки, на 1024–1199 ещё и голыми значками (critic-uiux.md P0-4,
 * P1-7). Стало: до восьми главных строк (тот же порядок, что вкладки, — с личной
 * настройкой «Порядок вкладок», preferences.navigation) и остальное в свёрнутых
 * группах по смыслу реестра (`NavItem.group`). Права не трогаются: на вход идут
 * уже отфильтрованные `main`/`all`; каждый путь показывается ровно один раз.
 *
 * 27.11.2026 (пачка shell2, макет): главных — ШЕСТЬ (ROYAL_PRIORITY), остальные
 * группы рисуются внутри одной раскрывающейся «Ещё» подзаголовками (CleanShell).
 */
export const ROYAL_PRIMARY_CAPACITY = 6;

export type RoyalNavGroupKey = "work" | "team" | "money" | "ads" | "system";

const GROUP_OF: Record<NavItem["group"], RoyalNavGroupKey> = {
  main: "work", inbox: "work", people: "work", objects: "work",
  team: "team", money: "money", ads: "ads", system: "system",
};

export const ROYAL_NAV_GROUP_TITLES: Record<RoyalNavGroupKey, string> = {
  work: "Работа",
  team: "Команда и контроль",
  money: "Отчёты",
  ads: "Маркетинг",
  system: "Система",
};

const GROUP_ORDER: RoyalNavGroupKey[] = ["work", "team", "money", "ads", "system"];

export interface RoyalNavGroup { key: RoyalNavGroupKey; title: string; items: NavItem[] }

export function royalSideNavigation(main: NavItem[], all: NavItem[], saved: unknown = [], capacity = ROYAL_PRIMARY_CAPACITY) {
  const { tabs, overflow } = partitionCleanNavigation(main, all, capacity, saved, ROYAL_PRIORITY);
  const seen = new Set(tabs.map((item) => item.to));
  const buckets = new Map<RoyalNavGroupKey, NavItem[]>();
  for (const item of overflow) {
    if (seen.has(item.to)) continue;
    seen.add(item.to);
    const key = GROUP_OF[item.group] ?? "system";
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const groups: RoyalNavGroup[] = GROUP_ORDER.flatMap((key) => {
    const items = buckets.get(key);
    return items?.length ? [{ key, title: ROYAL_NAV_GROUP_TITLES[key], items }] : [];
  });
  return { primary: tabs, groups };
}

/**
 * Раскрытые группы бокового меню помнятся на устройстве — удобство, а не настройка.
 * Ключ на сотрудника: на общем компьютере раскрытые группы одного не достаются другому.
 */
export const navGroupsKey = (agentId: string | undefined) => `rh-nav-groups:${agentId ?? "-"}`;
export function readOpenNavGroups(agentId: string | undefined, storage?: Pick<Storage, "getItem">): string[] {
  try {
    const store = storage ?? window.localStorage;
    const value = JSON.parse(store.getItem(navGroupsKey(agentId)) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}
