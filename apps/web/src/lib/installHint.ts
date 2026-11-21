/**
 * Когда предлагать «Поставьте CRM на экран» (аудит К06.1, 21.11.2026).
 *
 * Плавающая плашка висела над нижним меню и закрывала низ каждого экрана телефона. Теперь она стоит
 * строкой в самом экране (Главная), показывается ОДИН раз и только когда установка реально возможна.
 * Решение — чистая функция, чтобы тест держал все условия, а не только «рендерится».
 */

/** Раньше третьего захода не предлагаем: первый заход человек осматривается, второй — работает. */
export const INSTALL_HINT_MIN_VISITS = 3;
export const INSTALL_HINT_VISITS_KEY = "rh-visit-count";
/** Подсказка уже была показана на этом устройстве — второй раз не показываем. */
export const INSTALL_HINT_SHOWN_KEY = "rh-install-hint-shown";

export interface InstallOfferInput {
  /** Ширина телефона (< 820). */
  narrow: boolean;
  /** `available` — системный диалог готов; `ios` — только инструкция «Поделиться»; остальное — нельзя. */
  state: "installed" | "available" | "ios" | "unavailable";
  /** iPhone-браузер, в котором пункт «На экран „Домой"» есть (не встроенный просмотр Telegram, Instagram и т. п.). */
  iosCanAdd: boolean;
  visits: number;
  /** Человек нажал «Не сейчас» (запоминается в настройках). */
  dismissed: boolean;
  /** Подсказка уже показывалась в прошлых заходах. */
  shownBefore: boolean;
}

export function shouldOfferInstall(i: InstallOfferInput): boolean {
  if (!i.narrow || i.dismissed || i.shownBefore || i.visits < INSTALL_HINT_MIN_VISITS) return false;
  if (i.state === "available") return true;
  return i.state === "ios" && i.iosCanAdd;
}

/**
 * Браузер iPhone, где есть «Поделиться → На экран „Домой"». Встроенные просмотрщики (Telegram, Instagram,
 * Facebook, Line) пункта не имеют: инструкция в них отправила бы человека искать то, чего нет.
 * Safari и Chrome/Firefox/Edge на iOS в строке браузера несут «Safari/».
 */
export function iosCanAddToHome(ua: string): boolean {
  if (!/Safari\//.test(ua)) return false;
  return !/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|Twitter/i.test(ua);
}

let visitsThisLoad: number | null = null;
/** Считает заход ОДИН раз за загрузку приложения, сколько бы раз ни монтировался компонент. */
export function installVisitCount(): number {
  if (visitsThisLoad !== null) return visitsThisLoad;
  try {
    visitsThisLoad = Number(localStorage.getItem(INSTALL_HINT_VISITS_KEY) || "0") + 1;
    localStorage.setItem(INSTALL_HINT_VISITS_KEY, String(visitsThisLoad));
  } catch {
    visitsThisLoad = 0; // нет хранилища (приватный режим): считать нечего, не предлагаем
  }
  return visitsThisLoad;
}

let shownBeforeThisLoad: boolean | null = null;
/** Показывалась ли подсказка в ПРОШЛЫХ заходах (читается один раз за загрузку: в этом заходе она остаётся на месте). */
export function installHintShownBefore(): boolean {
  if (shownBeforeThisLoad !== null) return shownBeforeThisLoad;
  try {
    shownBeforeThisLoad = localStorage.getItem(INSTALL_HINT_SHOWN_KEY) === "1";
  } catch {
    shownBeforeThisLoad = true;
  }
  return shownBeforeThisLoad;
}
export function markInstallHintShown(): void {
  try {
    localStorage.setItem(INSTALL_HINT_SHOWN_KEY, "1");
  } catch {
    /* нет хранилища */
  }
}

/** Только для тестов. */
export function resetInstallHintMemo(): void {
  visitsThisLoad = null;
  shownBeforeThisLoad = null;
}
