import type { ClientSource } from "./enums.js";
import { CLIENT_SOURCE_LABELS } from "./labels.js";

/**
 * Единый реестр «откуда пришёл клиент» для людей (28.11.2026).
 *
 * Источников в базе 12 — для владельца это многовато: в блоке «Откуда приходят» он
 * видел WhatsApp, Instagram, Facebook, Звонок… отдельными строками. Здесь источники
 * собраны в понятные группы; подробности по каждому каналу остаются в подстроке.
 * Сам источник клиента в базе не меняется — группа считается только при показе.
 */
export const CLIENT_SOURCE_GROUPS = [
  { key: "MESSAGES", label: "Переписки", sources: ["WHATSAPP", "INSTAGRAM", "FACEBOOK", "TELEGRAM"] },
  { key: "CALLS", label: "Звонки", sources: ["PHONE_CALL"] },
  { key: "WEBSITE", label: "Сайт", sources: ["WEBSITE"] },
  { key: "ADS", label: "Реклама", sources: ["GOOGLE_ADS", "YANDEX_DIRECT", "TIKTOK"] },
  { key: "OWN", label: "Свои клиенты", sources: ["OWN_CLIENT"] },
  { key: "REFERRAL", label: "Рекомендации", sources: ["REFERRAL"] },
  { key: "OFFICE", label: "Пришли в офис", sources: ["WALK_IN"] },
] as const satisfies readonly { key: string; label: string; sources: readonly ClientSource[] }[];

export type ClientSourceGroupKey = (typeof CLIENT_SOURCE_GROUPS)[number]["key"] | "OTHER";

/**
 * Источники, где клиента завёл человек руками, а не канал связи (мессенджер, звонок,
 * сайт). «Пришёл в офис» так исторически помечали и карточки, заведённые агентом
 * (продавец при внесении объекта, ручной ввод), — поэтому проверки «карточку завёл
 * агент» (номер не подтверждён самой связью) должны видеть оба значения.
 */
export const AGENT_CREATED_CLIENT_SOURCES: readonly ClientSource[] = ["WALK_IN", "OWN_CLIENT"];

export function isAgentCreatedClientSource(source: string | null | undefined): boolean {
  return !!source && (AGENT_CREATED_CLIENT_SOURCES as readonly string[]).includes(source);
}

/** Простые подписи для агента в форме клиента: что значит каждый вариант. */
export const AGENT_CLIENT_SOURCE_CHOICES: readonly { value: ClientSource; label: string }[] = [
  { value: "OWN_CLIENT", label: "Свой клиент — нашёл сам (знакомый, обзвон, объявление, соцсети)" },
  { value: "REFERRAL", label: "Рекомендация — посоветовал другой клиент или знакомый" },
  { value: "PHONE_CALL", label: "Позвонил сам" },
  { value: "WALK_IN", label: "Пришёл в офис" },
];

export interface SourceStatRow {
  source: string;
  leads: number;
  deals: number;
  commission: number | null;
}

export interface SourceGroupRow {
  key: ClientSourceGroupKey;
  label: string;
  leads: number;
  deals: number;
  /** null — суммы не видно (нет права на деньги). */
  commission: number | null;
  /** Каналы внутри группы, у которых есть заявки или сделки, — крупные первыми. */
  parts: { source: string; label: string; leads: number; deals: number }[];
}

/**
 * Сворачивает строки «по источнику» в группы реестра. Строки без заявок и без сделок
 * отбрасываются; неизвестное значение (в базе появилось, а реестр ещё не знает) не
 * теряется — уходит в группу «Другое», чтобы итог сходился.
 */
export function groupSourceRows(rows: readonly SourceStatRow[]): SourceGroupRow[] {
  const groupOf = new Map<string, { key: ClientSourceGroupKey; label: string }>();
  for (const g of CLIENT_SOURCE_GROUPS) for (const s of g.sources) groupOf.set(s, { key: g.key, label: g.label });
  const acc = new Map<ClientSourceGroupKey, SourceGroupRow>();
  for (const r of rows) {
    if (r.leads <= 0 && r.deals <= 0) continue;
    const g = groupOf.get(r.source) ?? { key: "OTHER" as const, label: "Другое" };
    const cur = acc.get(g.key) ?? { key: g.key, label: g.label, leads: 0, deals: 0, commission: null, parts: [] };
    cur.leads += r.leads;
    cur.deals += r.deals;
    if (r.commission !== null) cur.commission = (cur.commission ?? 0) + r.commission;
    cur.parts.push({ source: r.source, label: CLIENT_SOURCE_LABELS[r.source as ClientSource] ?? r.source, leads: r.leads, deals: r.deals });
    acc.set(g.key, cur);
  }
  const out = [...acc.values()];
  for (const g of out) g.parts.sort((a, b) => b.leads - a.leads || b.deals - a.deals);
  return out.sort((a, b) => b.leads - a.leads || b.deals - a.deals || a.label.localeCompare(b.label));
}
