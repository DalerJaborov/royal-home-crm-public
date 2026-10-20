/**
 * «Маршрут на показ» (docs/geo-match-plan-12-09.md, блок N) — открывает
 * навигатор, УЖЕ стоящий у агента на телефоне, схемой-ссылкой; ничего не
 * установлено — веб-карта. Своей навигации не пишем (решение владельца).
 *
 * На телефоне: пробуем схему приложения, через короткий таймаут — веб-ссылка.
 * Признак «приложение открылось» — вкладка спряталась (`document.hidden`) до
 * срабатывания таймера; спрятаться она может и по другой причине (человек сам
 * переключился), поэтому это эвристика, а не гарантия, ровно как везде, где
 * так делают (пример из индустрии — Яндекс.Карты используют тот же приём).
 * На ПК схем приложений нет — сразу веб-ссылка.
 */
export type NavProvider = "yandex" | "2gis" | "google";

export const NAV_PROVIDER_LABEL: Record<NavProvider, string> = {
  yandex: "Яндекс Навигатор",
  "2gis": "2ГИС",
  google: "Google Maps",
};

function schemeUrl(provider: NavProvider, lat: number, lng: number): string | null {
  switch (provider) {
    case "yandex":
      return `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`;
    case "2gis":
      return `dgis://2gis.ru/routeSearch/rsType/car/to/${lng},${lat}`;
    case "google":
      // Google Maps не различает схему и веб-ссылку — универсальная ссылка сама
      // открывает приложение, если оно стоит, и сайт, если нет.
      return null;
  }
}

function webUrl(provider: NavProvider, lat: number, lng: number): string {
  switch (provider) {
    case "yandex":
      return `https://yandex.ru/maps/?rtext=~${lat},${lng}&rtt=auto`;
    case "2gis":
      return `https://2gis.ru/directions/points/|${lng},${lat}`;
    case "google":
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
}

/** Короткий таймаут перед откатом на веб — достаточно, чтобы схема успела
 *  передать управление ОС (открыть приложение или показать её собственную
 *  ошибку «схема не найдена»), но не настолько долгий, чтобы агент, у
 *  которого приложения нет, ждал и гадал, повисло ли. */
const SCHEME_FALLBACK_MS = 1200;

export function openRoute(provider: NavProvider, lat: number, lng: number, isMobile: boolean): void {
  const web = webUrl(provider, lat, lng);
  const scheme = schemeUrl(provider, lat, lng);
  if (!isMobile || !scheme) {
    window.open(web, "_blank", "noopener");
    return;
  }
  let fellBack = false;
  const onVisibility = () => {
    if (document.hidden) {
      fellBack = true;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    if (!fellBack) window.open(web, "_blank", "noopener");
  }, SCHEME_FALLBACK_MS);
  window.location.href = scheme;
}

/**
 * ОДНА КНОПКА ВМЕСТО ТРЁХ (владелец 15.09.2026: «убери в карточках объекта все
 * ссылки типа Яндекс, 2ГИС, Гугл и так далее — просто одна кнопка "проложить
 * маршрут" и иконка, пусть телефон сам решает, в какую карту отдавать»).
 *
 * «Телефон сам решает» устроено по-разному на двух системах, и это не наша
 * прихоть:
 *   • Android понимает схему `geo:` — её обрабатывает ЛЮБОЙ установленный
 *     навигатор, и если их несколько, систему сама показывает выбор. Это и есть
 *     то, о чём просил владелец.
 *   • iOS схемы `geo:` не знает вовсе. Родная карта там — Apple Maps
 *     (`maps://`), и открыть чужой навигатор без его схемы нельзя. Поэтому на
 *     iPhone кнопка ведёт в Apple Maps, а не в «выбор» — выбора там не бывает.
 *   • На компьютере схем приложений нет: открываем веб-карту.
 *
 * Запасной путь общий с openRoute(): если схема не увела в приложение за
 * SCHEME_FALLBACK_MS, открываем веб-версию — человек всё равно получает
 * маршрут, а не пустой экран.
 */
export function openRouteNative(lat: number, lng: number, isMobile: boolean): void {
  const web = webUrl("google", lat, lng);
  if (!isMobile) {
    window.open(web, "_blank", "noopener");
    return;
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const scheme = isIOS
    ? `maps://?daddr=${lat},${lng}&dirflg=d`
    : `geo:${lat},${lng}?q=${lat},${lng}`;

  let fellBack = false;
  const onVisibility = () => {
    if (document.hidden) {
      fellBack = true;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onVisibility);
    if (!fellBack) window.open(web, "_blank", "noopener");
  }, SCHEME_FALLBACK_MS);
  window.location.href = scheme;
}
