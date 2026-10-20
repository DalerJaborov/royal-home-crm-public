import type { Client, Interaction } from "../types";
import { dushanbeDate, dushanbeDayKey, dushanbeTime, dushanbeTodayKey } from "./date";

/**
 * ДЕНЬ АГЕНТА — общий счёт для обеих его Главных.
 *
 * Правила «что срочно», «кто остывает», «какие показы сегодня» и «где окно
 * между встречами» были написаны внутри components/home/AgentHome.tsx. С
 * появлением отдельной телефонной Главной их пришлось бы повторить второй
 * раз — а разъехавшиеся копии такой логики означают, что ПК и телефон
 * показывают агенту РАЗНЫЕ «горит сейчас», и никакая сборка об этом не
 * сообщит. Поэтому счёт живёт здесь один, а экраны только рисуют. С
 * 06.10.2026 экран один на обе ширины, порядок «Сначала это» и очереди — в
 * lib/agentFocus.ts поверх этих функций.
 *
 * Здесь только чистые функции над уже полученными данными: ни запросов, ни
 * React. Сколько дней считать молчанием и какие состояния закрыты — тоже
 * здесь, чтобы порог не оказался «3» на ПК и «5» на телефоне.
 */

/** Закрытые состояния в портфеле не показываются — по ним делать нечего. */
export const CLOSED = new Set(["LOST", "DEAL_CLOSED", "ARCHIVED"]);
export const DAY_MS = 24 * 60 * 60 * 1000;
/** С какого дня молчания клиент считается «остывает» (владелец: три дня). */
export const NO_CONTACT_DAYS = 3;
/** Короче часа окно между встречами не считается окном. */
const MIN_GAP_MS = 60 * 60 * 1000;

export type Urgency = "overdue" | "stalled" | "ok";

export function urgencyOf(client: Client, now: number): Urgency {
  const due = client.nextStep?.nextActionDate ? Date.parse(client.nextStep.nextActionDate) : null;
  if (due !== null && due < now) return "overdue";
  if (!client.nextStep?.nextAction) return "stalled";
  return "ok";
}

/** «сегодня 15:00» / «завтра» / «12 сент.» — дата шага по Душанбе (lib/date.ts). */
export function stepDay(iso: string): string {
  const date = new Date(iso);
  const time = dushanbeTime(date);
  const key = dushanbeDayKey(date);
  if (key === dushanbeTodayKey()) return `сегодня ${time}`;
  if (key === dushanbeDayKey(new Date(Date.now() + DAY_MS))) return `завтра ${time}`;
  return dushanbeDate(date, { day: "numeric", month: "short" });
}

export function daysSince(iso: string, now: number): number {
  return Math.floor((now - Date.parse(iso)) / DAY_MS);
}

/** Портфель по срочности: просроченные → без шага → ближайшие; внутри — кто дольше без контакта. */
export function buildPortfolio(clients: Client[], now: number): Client[] {
  const rank: Record<Urgency, number> = { overdue: 0, stalled: 1, ok: 2 };
  return clients
    .filter((c) => !c.pendingAcceptance && !CLOSED.has(c.status) && c.workStatus !== "INACTIVE")
    .sort((a, b) => {
      const byUrgency = rank[urgencyOf(a, now)] - rank[urgencyOf(b, now)];
      if (byUrgency !== 0) return byUrgency;
      return Date.parse(a.lastContactAt) - Date.parse(b.lastContactAt);
    });
}

/** Кто молчит дольше порога — дольше всех первым. */
export function buildNoContact(portfolio: Client[], now: number): Client[] {
  return portfolio
    .filter((c) => daysSince(c.lastContactAt, now) >= NO_CONTACT_DAYS)
    .sort((a, b) => Date.parse(a.lastContactAt) - Date.parse(b.lastContactAt));
}

/** Показы дня — из задач дня; отменённые и завершённые не считаются. */
export function buildShowings(tasks: Interaction[]): Interaction[] {
  return tasks
    .filter((t) => t.type === "SHOWING" && !t.completedAt && !t.declinedAt && t.nextActionDate)
    .sort((a, b) => Date.parse(a.nextActionDate!) - Date.parse(b.nextActionDate!));
}

/**
 * Окно между встречами: от «сейчас» до первого показа или самый большой
 * просвет между соседними, не короче часа. Без показов окна нет.
 */
export function findGap(showings: Interaction[], now: number): { from: number; to: number } | null {
  if (showings.length === 0) return null;
  const points = [now, ...showings.map((s) => Date.parse(s.nextActionDate!))].filter((t) => t >= now);
  let best: { from: number; to: number } | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (to - from >= MIN_GAP_MS && (!best || to - from > best.to - best.from)) best = { from, to };
  }
  return best;
}
