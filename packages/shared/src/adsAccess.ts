import { isReadOnlyRole } from "./enums.js";

/**
 * Кто может МЕНЯТЬ рекламу: подключать кабинет Meta, сверять, привязывать
 * объявления к объектам, отключать. Одно правило на три входа: HTTP-роут
 * `requireAdsWrite` (apps/api/src/routes/ads.ts), OAuth-колбэк Meta
 * (`completeConnect`, где `req.agent` нет и право проверяется заново) и кнопки
 * сайта (`useAds`), которые иначе показывались всем, кто видит экран, и ловили 403
 * (F10, 02.10.2026). Роль «только просмотр» не пишет ничего, даже с правом.
 */
export function canWriteAds(role: string | undefined, can: (permission: "finance.manage") => boolean): boolean {
  if (isReadOnlyRole(role)) return false;
  return role === "MARKETING" || can("finance.manage");
}
