import type { DirectorDashboardResponse } from "@royal-home/shared";

/**
 * ГЛАВНАЯ РУКОВОДИТЕЛЯ «КАК В МАКЕТЕ» (пачка home2, 27.11.2026) — правила без разметки,
 * чтобы их проверял тест: что показать на плите комиссии, на шкале скорости и в столбиках
 * «Заявки». Только из того, что сервер уже отдаёт; нет числа — нет плашки (не «0» и не «—»).
 */

/** Порог «долгого» первого ответа — тот же, что у утренней сводки (lib/morningNumbers.ts: firstTouchSlowCount — дольше часа). */
export const SLOW_FIRST_TOUCH_MIN = 60;

export interface GaugeView {
  /** Доля шкалы 0…1 (шкала — час: дальше часа стрелка стоит в конце). */
  share: number;
  tone: "ok" | "crit";
  /** Подпись-плашка: «быстрее часа» / «дольше часа». */
  verdict: string;
}

/** Шкала первого ответа: медиана в минутах → положение и смысл. Нет медианы — шкалы нет. */
export function gaugeView(medianMin: number | null | undefined): GaugeView | null {
  if (medianMin === null || medianMin === undefined || !Number.isFinite(medianMin) || medianMin < 0) return null;
  const slow = medianMin > SLOW_FIRST_TOUCH_MIN;
  return { share: Math.min(1, medianMin / SLOW_FIRST_TOUCH_MIN), tone: slow ? "crit" : "ok", verdict: slow ? "дольше часа" : "быстрее часа" };
}

/** Точка на дуге шкалы (полукруг слева направо, центр 100;100, радиус 80 — как в макете). */
export function gaugePoint(share: number): { x: number; y: number } {
  const angle = Math.PI * (1 - Math.min(1, Math.max(0, share)));
  return { x: Math.round((100 + 80 * Math.cos(angle)) * 10) / 10, y: Math.round((100 - 80 * Math.sin(angle)) * 10) / 10 };
}

export interface SourceColumn { source: string; label: string; leads: number; share: number; top: boolean }

/**
 * Столбики «Заявки»: четыре самых крупных источника за период (как в макете), остальные —
 * одной суммой строкой ниже, чтобы ни одна заявка не пропала из виду.
 */
export function sourceColumns(sources: DirectorDashboardResponse["sources"], limit = 4): { columns: SourceColumn[]; restLeads: number; restCount: number } {
  const rows = sources.filter((r) => r.leads > 0).sort((a, b) => b.leads - a.leads);
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.leads));
  const rest = rows.slice(limit);
  return {
    columns: shown.map((r, index) => ({ source: r.source, label: r.label, leads: r.leads, share: r.leads / max, top: index === 0 })),
    restLeads: rest.reduce((sum, r) => sum + r.leads, 0),
    restCount: rest.length,
  };
}

/** Потеряно за период — сумма причин отказа (тот же список, что «Почему теряем клиентов» ниже). */
export function lostTotal(data: Pick<DirectorDashboardResponse, "lossReasons">): number {
  return data.lossReasons.reduce((sum, r) => sum + Math.max(0, r.count), 0);
}

/** Процент плана: только при настоящем плане (не умолчании) и плане больше нуля. */
export function planPercent(fact: number, plan: number | null | undefined, planIsDefault: boolean | undefined): number | null {
  if (planIsDefault || plan === null || plan === undefined || !(plan > 0)) return null;
  return Math.max(0, Math.round((fact / plan) * 100));
}
