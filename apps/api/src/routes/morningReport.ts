import { visibleErrorLogs } from "../lib/systemErrorVisibility.js";
import { visibleSystemErrorWhere } from "../lib/investigationOperations.js";
/**
 * Утренний отчёт для рабочей Claude-сессии — те же числа, что уходят директору
 * пушем в 08:00 (см. cron.ts sendDirectorDigest), плюс сами пойманные ошибки.
 *
 * Зачем отдельный маршрут: директор видит в уведомлении «поймано 3 ошибки», а
 * что именно сломалось — только зайдя в Настройки. Сессия, которая эти ошибки и
 * чинит, узнавала о них последней. Теперь список приезжает в начало работы.
 *
 * Авторизация — служебный токен MORNING_REPORT_TOKEN в заголовке: сессия Claude
 * работает без пароля и вне браузера, логиниться ей нечем. Токен даёт доступ
 * ТОЛЬКО к этому отчёту и только на чтение — ни клиентов, ни финансов, ни
 * телефонов здесь нет, только счётчики и текст ошибок.
 *
 * Раньше отчёт висел на /api/v1/team-requests/morning-report и делил токен с
 * задачами от сотрудников. Та функция удалена, отчёт остался и переехал на
 * собственный путь.
 */

import { Router, type Request } from "express";
import { prisma } from "../db.js";
import { loadMorningNumbers } from "../lib/morningNumbers.js";
import { loadStuckPulse } from "../lib/stuckPulse.js";
import { secretsMatch } from "../lib/secretCompare.js";
import { classifyErrorLog, groupErrorLogEntries } from "../lib/errorLogClassify.js";

export const morningReportRouter = Router();

/** MORNING_REPORT_TOKEN — текущее имя. TEAM_REQUESTS_TOKEN поддержан запасным
 *  вариантом, чтобы прод не отвалился в промежуток между выкатом кода и правкой
 *  .env; после обновления переменных на сервере запасное имя можно убрать. */
function serviceTokenValid(req: Request): boolean {
  const expected = process.env.MORNING_REPORT_TOKEN || process.env.TEAM_REQUESTS_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return secretsMatch(header.slice("Bearer ".length), expected);
}

morningReportRouter.get("/", async (req, res) => {
  if (!serviceTokenValid(req)) return res.status(401).json({ error: "Нужен служебный токен" });

  // Те же числа, что уходят директору push-сводкой в 08:00 — одна функция на
  // оба отчёта (lib/morningNumbers.ts), иначе они расходятся при первой же правке.
  const [numbers, errorRows, stuck] = await Promise.all([
    loadMorningNumbers(),
    /**
     * Неразобранные ошибки за неделю — ОДНИМ окном для счётчика и для списка
     * (раньше счётчик был all-time и список за неделю, из-за чего «377» и
     * видимые под ним 25 строк не сходились ни по времени, ни по смыслу).
     * take — предел выборки (CLAUDE.md: у любого массива обязана быть
     * граница), 2000 с запасом покрывает даже затяжную аварию за неделю.
     */
    visibleErrorLogs().findMany({
      where: { ...visibleSystemErrorWhere(), resolvedAt: null, createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      orderBy: { createdAt: "desc" },
      take: 2000,
      select: { id: true, source: true, message: true, url: true, createdAt: true },
    }),
    /**
     * «Где люди застряли» — второй вопрос отчёта (владелец 27.08.2026).
     *
     * Журнал ошибок отвечает, ЧТО СЛОМАЛОСЬ. Но за один день владелец нашёл
     * руками четыре вещи, где не сломалось ничего: код работал точно как
     * написан, и при этом лиды не принимались, карточки не закрывались, окно
     * всплывало по удалённому клиенту, значок горел месяцами. Такое видно
     * только в данных — сколько людей упёрлось в правило и что копится.
     */
    loadStuckPulse(),
  ]);

  /**
   * ДВЕ КАТЕГОРИИ (аудит 03.09.2026 ночь, раздел 4-5) — эксплуатационный шум
   * ИИ-конвейера (резерв ответил, повтор помог/не помог) не должен будить и не
   * должен считаться директору: см. lib/errorLogClassify.ts. Полный список
   * (обе категории) как был, так и остаётся доступен через /errors — тому, у
   * кого есть auditLog.view, тем же правом, каким гейтится этот отчёт.
   */
  const actionableRows = errorRows.filter((e) => classifyErrorLog(e.source, e.message) === "actionable");
  const operationalCount = errorRows.length - actionableRows.length;
  // Уникальные ТИПЫ с count — «377» была суммой повторов одной и той же
  // поломки, а не числом разных проблем; директору нужны типы, не строки.
  const errorGroups = groupErrorLogEntries(actionableRows).slice(0, 30);

  res.json({
    tasksToday: numbers.tasksToday,
    leadsYesterday: numbers.leadsYesterday,
    dealsYesterday: numbers.dealsYesterday,
    commissionMonth: numbers.commissionMonth,
    // Скорость первого касания — та же цифра, что в push-сводке директору
    // (совет экспертов, пункт 7): отчёт и пуш обязаны говорить одно и то же.
    firstTouchMedianMin: numbers.firstTouchMedianMin,
    firstTouchSlowCount: numbers.firstTouchSlowCount,
    firstTouchNoneCount: numbers.firstTouchNoneCount,
    // Теперь только actionable и в том же недельном окне, что и errors/errorGroups
    // ниже — раньше здесь было all-time число, несогласованное со списком под ним.
    errorsUnresolvedTotal: actionableRows.length,
    // Технический счётчик — эксплуатационный шум того же окна, НЕ показывается
    // директору как тревога, но виден тому, кто читает этот отчёт разработчиком.
    errorsOperationalTotal: operationalCount,
    // Оставлено для обратной совместимости (сырые строки, actionable-only,
    // свежие сверху) — новые потребители должны читать errorGroups.
    errors: actionableRows.slice(0, 25),
    errorGroups,
    stuck,
    /**
     * Экраны, куда не заходил никто (карта обследованного, lib/routeHits.ts).
     * Зеркало списка ошибок: там — то, на что уже пожаловались, здесь — то, на
     * что пожаловаться было некому. Пустой, пока наблюдение идёт меньше недели.
     */
    unvisitedScreens: numbers.unvisitedScreens,
    // Пачка 9 (11.09.2026): грубый ежедневный счёт продавцов без объекта старше
    // недели — см. doc-comment у MorningNumbers в lib/morningNumbers.ts.
    sellersWithoutPropertyOver7Days: numbers.sellersWithoutPropertyOver7Days,
    // «Итог показа» просрочен больше 48 часов — прямо сейчас (пачка 10, 11.09.2026,
    // п.3). См. lib/pendingSummaries.ts, notifySupervisorsOfOverdueShowingSummaries.
    showingSummariesOverdue48h: numbers.showingSummariesOverdue48h,
    // Пачка 17 (12.09.2026): «бот на паузе и забыли» — см. doc-comment у
    // MorningNumbers.botPausedNoReply24h / lib/botPauseWatch.ts.
    botPausedNoReply24h: numbers.botPausedNoReply24h,
    // Пачка 13 (11.09.2026): «продано мимо агентства» за неделю — см. doc-comment
    // у MorningNumbers.soldElsewhereWeek в lib/morningNumbers.ts.
    soldElsewhereWeek: numbers.soldElsewhereWeek,
    // «Передумал продавать» и «пустышка» за неделю — раздельно, см. doc-comment
    // у MorningNumbers.changedMindWeek.
    changedMindWeek: numbers.changedMindWeek,
    emptySellerCardsWeek: numbers.emptySellerCardsWeek,
    // Пачка 11 (11.09.2026): ответы на вопрос об отзыве за вчера.
    reviewsYesterday: numbers.reviewsYesterday,
    // Пачка 18 (12.09.2026): пропущенные звонки без перезвона за вчера, на сейчас.
    missedCallsNoCallbackYesterday: numbers.missedCallsNoCallbackYesterday,
    // П-13 (18.09.2026): посты без карточки объекта за сутки — привязать через
    // POST /ads/link-post, см. doc-comment у MorningNumbers.unlinkedAdPosts.
    unlinkedAdPosts: numbers.unlinkedAdPosts,
    // 18.09.2026 (объект #82): объекты, снятые автоматически из-за «потерянного»
    // продавца, у которых продавец уже не «Потерянный» — см. doc-comment у
    // MorningNumbers.propertiesWithdrawnSellerRecovered.
    propertiesWithdrawnSellerRecovered: numbers.propertiesWithdrawnSellerRecovered,
    // 20.09.2026: отвеченные звонки, засчитанные по догадке (DIALSTATUS не
    // прочитан станцией) — см. doc-comment у MorningNumbers.unconfirmedAnswersYesterday.
    unconfirmedAnswersYesterday: numbers.unconfirmedAnswersYesterday,
    // 21.09.2026: «Что не доехало» — см. doc-comment у
    // MorningNumbers.stuckWorkGivenUpYesterday в lib/morningNumbers.ts.
    stuckWorkGivenUpYesterday: numbers.stuckWorkGivenUpYesterday,
    stuckWorkHangingNow: numbers.stuckWorkHangingNow,
    // 28.09.2026: «Раздать по группам Facebook» — см. doc-comment у
    // MorningNumbers.groupShareNotDoneCount в lib/morningNumbers.ts.
    groupShareNotDoneCount: numbers.groupShareNotDoneCount,
  });
});
