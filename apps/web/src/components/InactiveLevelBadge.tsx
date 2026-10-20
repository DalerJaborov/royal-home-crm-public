import type { Client } from "../types";

/**
 * Светофор неактивных на экране (lib/inactiveTrafficLight.ts, backend, живёт с
 * 21.08.2026, но до 31.08.2026 карточка красилась только в базе — ни одна
 * строка фронтенда inactiveLevel не читала, и агент/владелец видели один и тот
 * же жёлтый бейдж «Неактивный» независимо от реального уровня).
 *
 * Цвета и подписи — те же LEVEL_LABEL/LEVEL_EMOJI, что в push-уведомлении агенту
 * (см. backend), второй источник правды не заводим.
 */
export const INACTIVE_LEVEL_CLASSES: Record<"GREEN" | "YELLOW" | "RED", string> = {
  GREEN: "text-green bg-green-bg",
  YELLOW: "text-amber bg-amber-bg",
  RED: "text-red bg-red-bg",
};

export const INACTIVE_LEVEL_LABELS: Record<"GREEN" | "YELLOW" | "RED", string> = {
  GREEN: "зелёный",
  YELLOW: "жёлтый",
  RED: "красный",
};

/**
 * Смысл цветов переписан 03.09.2026 вместе с сервером: цвет ставит ГЛУБИНА
 * истории (была ли встреча, дозвонились ли), а не названная причина — см.
 * apps/api/src/lib/inactiveTrafficLight.ts::classifyInactiveLevelByDepth.
 */
export const INACTIVE_LEVEL_TITLES: Record<"GREEN" | "YELLOW" | "RED", string> = {
  GREEN: "Встреча или показ был — вложено больше всего, времени на возврат тоже",
  YELLOW: "Дозвонились хотя бы раз, но до встречи или показа не дошли",
  RED: "Ни разу не дозвонились: живого разговора не было вовсе",
};

/** Модификатор чипа темы «Royal Home 2026» (`.chip ok/warn/crit`) — для мест,
 *  где бейдж рисуется прототипной разметкой, а не Tailwind-классами выше. */
export const INACTIVE_LEVEL_TONE: Record<"GREEN" | "YELLOW" | "RED", string> = {
  GREEN: "ok",
  YELLOW: "warn",
  RED: "crit",
};

/**
 * Показывать ли клиенту метку «Неактивный» (23.09.2026). Потерянный через
 * светофор сохраняет workStatus=INACTIVE (сервер, clientLifecycle.ts::
 * markClientLost), и без проверки status на карточке рядом стояли «Потерянный»
 * и «Неактивный» — второе читалось как «с ним ещё работают». Неактивный — это
 * тот, с кем ещё работают; потерянный — уже нет. Одно правило на все экраны,
 * то же, что у сервера в счётчиках светофора (routes/oversight.ts, list.ts).
 */
export function showsInactiveLabel(client: { workStatus?: string | null; status?: string | null }): boolean {
  return client.workStatus === "INACTIVE" && client.status !== "LOST";
}

/** Плашка на карточке клиента — заменяет прежний статичный жёлтый «Неактивный». */
export function InactiveLevelBadge({ client }: { client: Pick<Client, "workStatus" | "inactiveLevel" | "status"> }) {
  if (!showsInactiveLabel(client)) return null;
  const level = client.inactiveLevel;
  const classes = level ? INACTIVE_LEVEL_CLASSES[level] : "text-amber bg-amber-bg";
  const title = level
    ? `${INACTIVE_LEVEL_TITLES[level]}, слот в лимите активных лидов освобождён`
    : "Работа с клиентом приостановлена до 21.08.2026, без цвета светофора, слот в лимите активных лидов освобождён";
  // НАЗВАНИЕ ЦВЕТА В ПОДПИСЬ НЕ ПИШЕМ (07.09.2026). Бейдж уже покрашен этим цветом —
  // слово его только дублирует, а на карточке рядом стоят другие цветные плашки со
  // своими шкалами («Сделка закрыта» зелёная, «молчит 10 дней» красная). Красное
  // слово «красный» рядом с зелёным «Сделка закрыта» читается как ошибка системы,
  // хотя это просто три независимых признака. Смысл уровня остался в подсказке
  // (INACTIVE_LEVEL_TITLES) — там он объяснён словами, а не назван цветом.
  return (
    <span title={title} className={`text-[13px] font-semibold rounded-badge px-2 py-0.5 ${classes}`}>
      Неактивный
    </span>
  );
}

/** Точка в списке клиентов — рядом с ClientStatusBadge, не заменяет её:
 *  ClientStatusBadge показывает Новый/Горячий/…, эта точка — рабочий статус. */
export function InactiveLevelDot({ client }: { client: Pick<Client, "workStatus" | "inactiveLevel" | "status"> }) {
  if (!showsInactiveLabel(client)) return null;
  const level = client.inactiveLevel;
  const dotClass = level === "GREEN" ? "bg-green" : level === "RED" ? "bg-red" : "bg-amber";
  const title = level ? `Неактивный · светофор: ${INACTIVE_LEVEL_LABELS[level]}` : "Неактивный, без цвета светофора";
  return <span title={title} className={`inline-block w-[7px] h-[7px] rounded-full shrink-0 ${dotClass}`} />;
}
