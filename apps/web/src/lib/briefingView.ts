import { briefingSeenKey, isBriefingWindow } from "@royal-home/shared";

/**
 * Чистая логика карточки «Утренний брифинг»: когда она развёрнута и что
 * считается «уже прослушан сегодня».
 *
 * Вынесено из компонента намеренно: vitest в apps/web живёт в режиме node
 * (см. vitest.config.ts, jsdom не установлен), и проверить это можно только
 * функциями без DOM.
 */

/** Развёрнутая карточка или свёрнутая строка «Брифинг за сегодня». */
export type BriefingCardMode = "expanded" | "collapsed";

/**
 * Разворачиваем с 08:00 до 12:00 по Душанбе и только пока брифинг не
 * прослушан и не закрыт в этот день. В остальное время — свёрнутая строка,
 * которая по клику разворачивается вручную.
 */
export function briefingCardMode(dushanbeHour: number, seen: boolean): BriefingCardMode {
  return isBriefingWindow(dushanbeHour) && !seen ? "expanded" : "collapsed";
}

/** localStorage может быть недоступен (приватное окно, запрет сайту) — молча. */
export function readBriefingSeen(dushanbeDate: string): boolean {
  try {
    return window.localStorage.getItem(briefingSeenKey(dushanbeDate)) === "1";
  } catch {
    return false;
  }
}

export function markBriefingSeen(dushanbeDate: string): void {
  try {
    window.localStorage.setItem(briefingSeenKey(dushanbeDate), "1");
  } catch {
    // Не смогли запомнить — карточка просто развернётся снова. Это лучше,
    // чем упавший экран из-за отключённого хранилища.
  }
}
