import { Router } from "express";
import { prisma } from "../db.js";
import { cachedOwnerReport, shouldCountOwnerReportView } from "../lib/ownerReport/cache.js";
import { loadOwnerReport } from "../lib/ownerReport/load.js";
import { OWNER_REPORT_TOKEN_RE } from "../lib/ownerReport/link.js";
import { logSystemError } from "../lib/systemError.js";
import { shareSaleStatus } from "./propertyShare.js";

/**
 * ПУБЛИЧНАЯ СТРАНИЦА «ОТЧЁТ ВЛАДЕЛЬЦУ» — GET /api/v1/public/owner-report/:token (03.10.2026).
 *
 * БЕЗ requireAuth намеренно: владелец квартиры не пользователь CRM. Безопасность держится
 * на неугадываемости токена (32 случайных байта, lib/ownerReport/link.ts) и на том, ЧТО
 * отдаётся: только агрегаты (числа, темы, текст рекомендации) — ни имён, ни телефонов, ни
 * цитат, ни денег компании, ни чужих объектов. Форма ответа — OwnerReportResponse
 * (packages/shared/src/ownerReport.ts), тест `owner-report-public.test.ts` перебирает
 * весь JSON и ищет запрещённое.
 *
 * Образец безопасности — публичная ссылка клиента `/l/:token` (routes/propertyShare.ts):
 *  • неверный, отозванный и «объект удалён» дают ОДИН И ТОТ ЖЕ 404 с одним и тем же
 *    телом: по ответу нельзя узнать, существовал ли токен;
 *  • свой потолок запросов (`ownerReportLimiter` в app.ts);
 *  • `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` —
 *    и на 404 тоже: промежуточный кэш и поисковик не должны запомнить ни ответ, ни его отсутствие.
 *
 * Отдельным роутером, а не внутри propertiesRouter: тот весь на requireAuth, и класть публичный
 * путь посреди приватных — верный способ унаследовать чужую проверку прав при следующей правке.
 */
export const ownerReportPublicRouter = Router();

const NOT_FOUND = { error: "Ссылка недействительна" } as const;

ownerReportPublicRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

ownerReportPublicRouter.get("/:token", async (req, res) => {
  const token = String(req.params.token);
  // Токен не нашей формы — тот же 404, что и «не найден», и до базы не доходим.
  if (!OWNER_REPORT_TOKEN_RE.test(token)) return res.status(404).json(NOT_FOUND);

  const link = await prisma.propertyOwnerReportLink.findUnique({
    where: { token },
    select: { id: true, propertyId: true, revokedAt: true, property: { select: { deletedAt: true } } },
  });
  // Отозвана или объект удалён — до кэша: гаснет сразу, а не через время жизни кэша отчёта.
  if (!link || link.revokedAt || link.property.deletedAt) return res.status(404).json(NOT_FOUND);

  let report;
  try {
    report = await cachedOwnerReport(link.propertyId, () => loadOwnerReport(link.propertyId, shareSaleStatus));
  } catch (err) {
    void logSystemError("api", `«Отчёт владельцу» не собран: ${err instanceof Error ? err.message : String(err)}`, {
      dedupKey: "owner-report-public",
    });
    return res.status(500).json({ error: "Не удалось собрать отчёт, попробуйте позже" });
  }
  // Объект удалён — для посетителя это та же «недействительная ссылка».
  if (!report) return res.status(404).json(NOT_FOUND);

  // Счётчик открытий — для агента («читал ли владелец»). Не ждём и не роняем страницу. Не чаще
  // раза в минуту на ссылку: иначе каждый GET был бы ещё и записью в базу. Открытие самим
  // сотрудником отличить нельзя (страница идёт без cookie и заголовка входа, см.
  // PublicOwnerReport.tsx), поэтому счётчик в карточке объекта подписан «включая ваши открытия».
  if (shouldCountOwnerReportView(link.id)) {
    void prisma.propertyOwnerReportLink
      .update({ where: { id: link.id }, data: { lastViewedAt: new Date(), viewsCount: { increment: 1 } } })
      .catch((err) => {
        void logSystemError("api", `Открытие «отчёта владельцу» не засчитано: ${err instanceof Error ? err.message : String(err)}`, {
          dedupKey: "owner-report-view-count",
        });
      });
  }

  res.json(report);
});
