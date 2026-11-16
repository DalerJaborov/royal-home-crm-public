/**
 * Роли кабинета маркетинга (MARKETING, DIRECTOR, ADMIN) — право «Убрать из
 * соцсетей» и «Вернуть монтажёру» со снятием постов. Вынесено из
 * `routes/marketing.ts` (31.10.2026, П3), чтобы ИИ-помощник проверял роль тем же
 * кодом, не подтягивая в `lib/` целый роутер. Роут реэкспортирует функцию.
 */
export function hasMarketingRole(role: string | undefined): boolean {
  return role === "MARKETING" || role === "DIRECTOR" || role === "ADMIN";
}

/**
 * Подключить или отключить внешний аккаунт компании (рекламный кабинет Meta,
 * TikTok, Threads, Google, Яндекс) — только деньги компании: директор и админ
 * (аудит прав М5/М7, владелец 16.11.2026). Маркетолог по-прежнему видит статус и
 * публикует, но переключить канал компании на чужой аккаунт не может.
 */
export function requireChannelAdmin(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (!req.agent) return res.status(401).json({ error: "Требуется авторизация" });
  if (req.agent.permissions.has("finance.manage")) return next();
  return res.status(403).json({ error: "Подключать и отключать каналы может только директор" });
}
