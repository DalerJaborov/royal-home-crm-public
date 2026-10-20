/**
 * СГЕНЕРИРОВАНО: apps/web/scripts/extract-screens.mjs — руками не править.
 *
 * Полный список экранов CRM. Нужен карте обследованного: сервер вычитает из
 * него посещённые (таблица RouteHit) и в утреннем отчёте показывает разность —
 * разделы, куда не заходил никто.
 *
 * Обновляется вместе с App.tsx: добавили маршрут — перегенерируйте
 * (`npm run screens --workspace=apps/web`), иначе новый экран будет считаться
 * несуществующим и выпадет из карты.
 */
export const ALL_SCREENS: readonly string[] = [
  "/",
  "/activity",
  "/ads",
  "/ai-learning",
  "/archive",
  "/bot-training",
  "/calendar",
  "/calls",
  "/clients",
  "/clients/:id",
  "/comments",
  "/deals",
  "/deferred-clients",
  "/finance",
  "/funnel",
  "/hall-of-fame",
  "/health",
  "/insights",
  "/l/:token",
  "/login",
  "/lost-clients",
  "/marketing",
  "/messages",
  "/mission-control",
  "/more",
  "/notifications",
  "/other-inquiries",
  "/oversight",
  "/profile",
  "/properties",
  "/properties/:id",
  "/properties/:id/edit",
  "/properties/map",
  "/properties/new",
  "/reports",
  "/security",
  "/sellers",
  "/settings",
  "/settings/roles",
  "/site-changes",
  "/sources",
  "/team",
  "/telephony",
  "/vacancies",
];
