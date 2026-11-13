import type { MetaLoginAssets, MetaLoginConnectInput } from "@royal-home/shared";

/**
 * Выбор после «Войти через Facebook» (13.11.2026) — чистые правила экрана
 * Настройки → Каналы, отдельно от разметки, чтобы проверять их тестом.
 */

export interface MetaLoginSelection {
  pages: string[];
  instagram: string[];
  adAccounts: string[];
}

export const EMPTY_SELECTION: MetaLoginSelection = { pages: [], instagram: [], adAccounts: [] };

/**
 * Что отмечено сразу: всё новое, что можно подключить. Уже подключённое не
 * отмечаем (его можно отметить руками — это обновит ключ), основную Страницу из
 * Настроек отметить нельзя вовсе, закрытые кабинеты — не отмечаем.
 */
export function defaultMetaLoginSelection(assets: MetaLoginAssets): MetaLoginSelection {
  return {
    pages: assets.pages.filter((p) => !p.connected && p.canMessage).map((p) => p.id),
    instagram: assets.instagram.filter((i) => !i.connected).map((i) => i.id),
    adAccounts: assets.adAccounts.filter((a) => !a.connected && a.status === 1).map((a) => a.id),
  };
}

export function toggleInSelection(selection: MetaLoginSelection, kind: keyof MetaLoginSelection, id: string, on: boolean): MetaLoginSelection {
  const rest = selection[kind].filter((x) => x !== id);
  return { ...selection, [kind]: on ? [...rest, id] : rest };
}

export function selectionToInput(selection: MetaLoginSelection): MetaLoginConnectInput {
  return { pageIds: selection.pages, instagramIds: selection.instagram, adAccountIds: selection.adAccounts };
}

export function selectionSize(selection: MetaLoginSelection): number {
  return selection.pages.length + selection.instagram.length + selection.adAccounts.length;
}

/** Что принёс адрес после возврата из Facebook: сессия выбора, ошибка или ничего. */
export function readMetaLoginParam(params: URLSearchParams): { kind: "session"; id: string } | { kind: "error"; message: string } | null {
  const value = params.get("metaLogin");
  if (!value) return null;
  if (value === "error") return { kind: "error", message: params.get("message") || "Не удалось войти через Facebook." };
  return /^[a-f0-9]{36}$/.test(value) ? { kind: "session", id: value } : { kind: "error", message: "Ссылка входа устарела — войдите через Facebook заново." };
}

/** Параметры адреса без следов входа — чтобы обновление страницы не открывало выбор снова. */
export function withoutMetaLoginParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("metaLogin");
  next.delete("message");
  return next;
}
