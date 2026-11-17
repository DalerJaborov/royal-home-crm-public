import { prisma } from "../db.js";

/**
 * СНИМОК НОЧНОЙ САМОПРОВЕРКИ ВНЕШНИХ ДОСТУПОВ — ЧТЕНИЕ (17.11.2026).
 *
 * Пишет снимок cron.ts после `lib/integrationHealth.ts::runIntegrationHealthChecks()`.
 * Читают двое: экран `/integrations` (routes/integrations.ts) и помощница Шабнам
 * (get_stuck_work). Живые проверки здесь НЕ запускаются: они бьют по Gemini/Meta/R2
 * и дублируют тревоги ночного прогона. Отдельный маленький модуль, а не функция в
 * integrationHealth.ts: тот тянет клиентов Telegram/Meta/ИИ, а чтению снимка нужен
 * только prisma.
 *
 * Пустой список — снимка ещё нет (до первого ночного тика): читатель обязан сказать
 * «нет данных», а не «всё в порядке».
 */
export interface IntegrationHealthRow {
  name: string;
  /** true — жив, false — сломан, null — не настроен. */
  ok: boolean | null;
  detail: string | null;
  checkedAt: Date;
}

export async function loadIntegrationHealthSnapshot(): Promise<IntegrationHealthRow[]> {
  const rows = await prisma.integrationHealthSnapshot.findMany({ orderBy: { name: "asc" }, take: 200 });
  return rows.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail, checkedAt: r.checkedAt }));
}
