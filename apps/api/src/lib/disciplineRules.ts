import { prisma } from "../db.js";
import { dushanbeWallClock } from "./dushanbeTime.js";

/**
 * НАСТРОЙКИ ДИСЦИПЛИНЫ И ДНЕВНОЕ ОКНО.
 *
 * Выделено 13.09.2026 из `lib/pendingSummaries.ts`, когда механизм обязательных
 * окон был удалён целиком (владелец: «вообще убери»). Сам загрузчик остался: к
 * окнам он давно относился лишь частью полей, а остальное — сроки перезвона
 * после недозвона, «покупатель думает», «продавец без объекта», окно дневного
 * времени — живёт своей жизнью в других механизмах и никуда не делось.
 *
 * Имя сменилось вместе со смыслом: `loadSummaryRules` в файле про удалённые
 * окна читалось бы как остаток, который забыли убрать.
 *
 * ДНЕВНОЕ ОКНО (`nextDaytimeSlot`) — общее правило: то, что система просит у
 * человека, она просит днём. Напоминание, выпавшее на три часа ночи, либо не
 * будет выполнено, либо будет выполнено кое-как, и второе хуже.
 */


const FALLBACK = {
  windowStart: "10:00",
  windowEnd: "15:00",
  noAnswerRetryMinutes: 15,
  noAnswerMaxAttempts: 3,
  noAnswerTailEnabled: false,
  noAnswerTailDay1: 2,
  noAnswerTailDay2: 5,
  meetingSummaryAfterShowingMinutes: 90,
  sellerPropertyMissingWarnDays: 3,
  buyerThinkingFirstPingHours: 48,
  missedCallbackHours: 2,
  missedCallbackEscalateHours: 6,
};

export interface DisciplineRules {
  windowStart: string;
  windowEnd: string;
  /** Через сколько минут повторить звонок клиенту, который не ответил. */
  noAnswerRetryMinutes: number;
  /** Сколько попыток подряд, прежде чем поставить руководителю задачу «Проверить контакт». */
  noAnswerMaxAttempts: number;
  /** «Хвост» дозвона (01.09.2026, Settings.noAnswerTail*): после эскалации — ещё две
   *  отложенные попытки самому агенту, через noAnswerTailDay1/Day2 дней. Выключено,
   *  пока noAnswerTailEnabled=false (см. lib/noAnswerStreak.ts). */
  noAnswerTailEnabled: boolean;
  noAnswerTailDay1: number;
  noAnswerTailDay2: number;
  /** Через сколько минут после НАЗНАЧЕННОГО времени показа показ считается
   *  состоявшимся. Раньше этим сроком открывалось окно «Итог показа»; окна
   *  удалены 13.09.2026, срок остался — по нему живут напоминания и подстраховки. */
  meetingSummaryAfterShowingMinutes: number;
  /** «Продавец без объекта» (Settings, владелец 21.08.2026) — жёлтый уровень
   *  антифрода: через столько дней после встречи отсутствие карточки объекта
   *  перестаёт быть нормой. */
  sellerPropertyMissingWarnDays: number;
  /** «Покупатель думает» (Settings.buyerThinkingFirstPingHours, владелец 21.08.2026):
   *  первое напоминание автоматической подстраховки (lib/buyerThinkingSlowTrack.ts),
   *  которая включается, когда агент не назначил свою дату повторного контакта:
   *  его собственный выбор остаётся основным путём и подстраховку не запускает,
   *  иначе клиент получал бы два напоминания на один показ. */
  buyerThinkingFirstPingHours: number;
  /** Пороги неотвеченного звонка (Settings, 11.09.2026): через сколько часов
   *  рабочего времени недозвон считается неперезвоненным и через сколько
   *  эскалируется руководителю (routes/calls.ts, telephony/missedCallEscalation.ts). */
  missedCallbackHours: number;
  missedCallbackEscalateHours: number;
}

export async function loadDisciplineRules(): Promise<DisciplineRules> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: {
        propertySummaryWindowStart: true,
        propertySummaryWindowEnd: true,
        noAnswerRetryMinutes: true,
        noAnswerMaxAttempts: true,
        noAnswerTailEnabled: true,
        noAnswerTailDay1: true,
        noAnswerTailDay2: true,
        meetingSummaryAfterShowingMinutes: true,
        sellerPropertyMissingWarnDays: true,
        buyerThinkingFirstPingHours: true,
        missedCallbackHours: true,
        missedCallbackEscalateHours: true,
      },
    });
    return {
      windowStart: s?.propertySummaryWindowStart ?? FALLBACK.windowStart,
      windowEnd: s?.propertySummaryWindowEnd ?? FALLBACK.windowEnd,
      noAnswerRetryMinutes: s?.noAnswerRetryMinutes ?? FALLBACK.noAnswerRetryMinutes,
      noAnswerMaxAttempts: s?.noAnswerMaxAttempts ?? FALLBACK.noAnswerMaxAttempts,
      noAnswerTailEnabled: s?.noAnswerTailEnabled ?? FALLBACK.noAnswerTailEnabled,
      noAnswerTailDay1: s?.noAnswerTailDay1 ?? FALLBACK.noAnswerTailDay1,
      noAnswerTailDay2: s?.noAnswerTailDay2 ?? FALLBACK.noAnswerTailDay2,
      meetingSummaryAfterShowingMinutes: s?.meetingSummaryAfterShowingMinutes ?? FALLBACK.meetingSummaryAfterShowingMinutes,
      sellerPropertyMissingWarnDays: s?.sellerPropertyMissingWarnDays ?? FALLBACK.sellerPropertyMissingWarnDays,
      buyerThinkingFirstPingHours: s?.buyerThinkingFirstPingHours ?? FALLBACK.buyerThinkingFirstPingHours,
      missedCallbackHours: s?.missedCallbackHours ?? FALLBACK.missedCallbackHours,
      missedCallbackEscalateHours: s?.missedCallbackEscalateHours ?? FALLBACK.missedCallbackEscalateHours,
    };
  } catch {
    return { ...FALLBACK };
  }
}

/** Минуты от полуночи для «ЧЧ:ММ». Неразборчивое время трактуем как отсутствие

 *  границы: сломанная настройка не должна прятать требование навсегда. */
function minutesOf(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Ближайший момент, когда окно «Итог объекта» уместно показать.
 *
 * Внутри дневного окна — сразу. Раньше него (раннее утро) — к началу окна сегодня.
 * После него (вечер и ночь) — к началу окна ЗАВТРА. Именно перенос, а не показ
 * ночью: отчёт, которого требуют в три часа ночи, либо не будет написан, либо
 * будет написан кое-как, и второе хуже.
 */
export function nextDaytimeSlot(at: Date, rules: DisciplineRules): Date {
  const startMin = minutesOf(rules.windowStart, 10 * 60);
  const endMin = minutesOf(rules.windowEnd, 15 * 60);
  const wall = dushanbeWallClock(at);
  const nowMin = wall.getUTCHours() * 60 + wall.getUTCMinutes();

  if (nowMin >= startMin && nowMin < endMin) return at;
  // Сколько минут ждать до ближайшего начала окна: сегодня или завтра.
  const waitMin = nowMin < startMin ? startMin - nowMin : 24 * 60 - nowMin + startMin;
  return new Date(at.getTime() + waitMin * 60_000);
}

