/**
 * Настройки, которые держат ОДНО поведение вдвоём (аудит 28.09.2026).
 *
 * Жалоба владельца: «меняю одну — молча перестаёт работать другая». Два тумблера
 * на одно поведение здесь не сливаются в один (у каждого своя история и свои
 * читатели на сервере) — вместо этого каждый показывает состояние второго и
 * говорит прямо, что нужны оба. Условия повторяют сервер дословно:
 *
 *  - напоминания молчащим — `sendFollowUps` в apps/api/src/cron.ts: botEnabled,
 *    botCanFollowUp, followUpEnabled и followUpMaxAttempts > 0 одновременно;
 *  - просьба подтвердить показ — `sendShowingConfirmationRequests` в
 *    apps/api/src/lib/meetingReminders.ts: askClientsToConfirmShowings и
 *    botCanConfirmShowings одновременно (botCanBookShowings НЕ участвует);
 *  - «Предлагать освободить место» — `acceptLead` в apps/api/src/lib/leadAccept.ts:
 *    ownPropertyReleaseEnabled и ownPropertyOverLimitEnabled (у второго нет
 *    тумблера на экране) одновременно;
 *  - порог «свой объект» — `pickByPropertyMatch` в
 *    apps/api/src/services/leads/assignment.ts сравнивает его с баллом
 *    scoreClientProperty (routes/matching.ts) без бонуса горячему.
 *
 * Здесь только тексты и расчёт — разметку рисуют вкладки. Чистые функции, чтобы
 * сверить их тестом, а не глазами.
 */

export interface FollowUpSwitches {
  botEnabled?: boolean;
  botCanFollowUp?: boolean;
  followUpEnabled?: boolean;
  followUpMaxAttempts?: number | null;
}

/** Совпадает с followUpLimit на сервере для значений, которые пропускает Zod (0..3). */
function followUpAttempts(s: FollowUpSwitches): number {
  return s.followUpMaxAttempts ?? 1;
}

/**
 * Почему напоминания молчащим не уходят, хотя смотрящий тумблер включён.
 * `from` — чей тумблер спрашивает: «ability» — «Напоминать молчащим клиентам»
 * (Что бот умеет), «schedule» — «Напоминать клиенту, который замолчал» (Когда бот
 * пишет). null — со стороны второго тумблера и числа всё в порядке.
 */
export function followUpBlockedBy(s: FollowUpSwitches, from: "ability" | "schedule"): string | null {
  const botCanFollowUp = s.botCanFollowUp ?? true;
  const followUpEnabled = s.followUpEnabled ?? true;
  if (from === "ability" && !followUpEnabled) {
    return "Сейчас напоминания не уходят: в разделе «Когда бот пишет» выключено «Напоминать клиенту, который замолчал». Для напоминаний нужны оба тумблера.";
  }
  if (from === "schedule" && !botCanFollowUp) {
    return "Сейчас напоминания не уходят: в разделе «Рубильник и каналы» → «Что бот умеет» выключено «Напоминать молчащим клиентам». Для напоминаний нужны оба тумблера.";
  }
  if (followUpAttempts(s) === 0) {
    return "Сейчас напоминания не уходят: в разделе «Когда бот пишет» число напоминаний — ноль. Выберите одно, два или три.";
  }
  if (!(s.botEnabled ?? true)) {
    return "Сейчас напоминания не уходят: бот выключен целиком (рубильник «Бот отвечает клиентам»).";
  }
  return null;
}

export interface ShowingConfirmSwitches {
  askClientsToConfirmShowings?: boolean;
  botCanConfirmShowings?: boolean;
}

/** Что происходит, когда просьба подтвердить показ работает. Один текст на обе
 *  вкладки: раньше «Бот» обещал «накануне… клиента и собственника», «Лиды» —
 *  «за 4 часа», а код делает второе и пишет только клиенту. */
export const SHOWING_CONFIRM_ON_TEXT =
  "За 4 часа до показа клиенту в мессенджер уходит просьба ответить «да». Если 4 часа выпадают на ночь (показ раньше 13:00), спрашиваем накануне в 19:00. Не ответил — агенту приходит сигнал позвонить; показ при этом не отменяется. Собственнику ничего не пишется.";

/** Почему просьба подтвердить показ не уходит, хотя смотрящий тумблер включён. */
export function showingConfirmBlockedBy(s: ShowingConfirmSwitches, from: "bot" | "leads"): string | null {
  if (from === "bot" && !(s.askClientsToConfirmShowings ?? false)) {
    return "Сейчас просьбы не уходят: во вкладке «Лиды» → «Уведомления» выключено «Просить клиента подтвердить показ». Нужны оба тумблера.";
  }
  if (from === "leads" && !(s.botCanConfirmShowings ?? true)) {
    return "Сейчас просьбы не уходят: во вкладке «Бот» → «Что бот умеет» выключено «Просить подтверждение встречи». Нужны оба тумблера.";
  }
  return null;
}

export interface ReleaseSwitches {
  ownPropertyReleaseEnabled?: boolean;
  ownPropertyOverLimitEnabled?: boolean;
}

/** Работает ли «Предлагать освободить место» на самом деле — так, как проверяет
 *  acceptLead. Второе поле без тумблера: экран показывает итог, а не одно поле. */
export function releaseEffectiveOn(s: ReleaseSwitches): boolean {
  return (s.ownPropertyReleaseEnabled ?? true) && (s.ownPropertyOverLimitEnabled ?? true);
}

/** Что отправить при нажатии. Включение поднимает и скрытое поле: иначе тумблер
 *  «включался» бы без всякого действия. Выключение трогает только своё поле. */
export function releaseToggleBody(currentlyOn: boolean): Record<string, boolean> {
  return currentlyOn
    ? { ownPropertyReleaseEnabled: false }
    : { ownPropertyReleaseEnabled: true, ownPropertyOverLimitEnabled: true };
}

export interface ScoreWeights {
  base: number;
  district: number;
  rooms: number;
  budget: number;
  distance: number;
}

/** Самый большой балл, который пара может набрать при поиске объектов под клиента
 *  (бонус горячему там не начисляется), с потолком 100 — как в scoreClientProperty. */
export function maxOwnPropertyScore(w: ScoreWeights): number {
  return Math.min(100, w.base + w.district + w.rooms + w.budget + w.distance);
}

/** Одна строка о пороге «свой объект» в свете текущих весов — для обеих вкладок. */
export function ownPropertyThresholdNote(threshold: number, w: ScoreWeights): string {
  const max = maxOwnPropertyScore(w);
  if (max < threshold) {
    return `При нынешних весах пара набирает не больше ${max} из 100 — порог ${threshold} недостижим, правило «свой объект» по совпадению не сработает ни разу.`;
  }
  const rest = Math.max(0, threshold - w.base);
  return `Сейчас база ${w.base}: чтобы дойти до порога ${threshold}, району, месту на карте, комнатам и бюджету вместе нужно дать ещё ${rest}. Поменяли веса — сдвинулся и смысл порога.`;
}
