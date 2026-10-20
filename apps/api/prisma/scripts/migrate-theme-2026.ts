/**
 * BACKFILL: Agent.preferences.theme → одна из двух тем «Royal Home 2026»
 * (слой 4, 08.09.2026, docs/pult/theme-2026/layer-3-plan.md §4.2/§4.3, задача 3).
 *
 * Предыстория. THEME_IDS (packages/shared/src/enums.ts) сузился до
 * "royal-home-2026-light"/"royal-home-2026-night" — шесть старых тем убраны из
 * реестра. Живые Agent.preferences хранят JSON, где theme может быть одним из
 * старых id ("royal-glass", "midnight", ...) или вовсе отсутствовать. В отличие
 * от прав (properties.viewAll → оба новых), у темы один валидный дефолт — здесь
 * не разворот "в оба варианта", а перезапись одним значением: тёмная старая тема
 * → -night (сохраняем намерение «тёмная», кто выбрал тёмную — останется в
 * тёмной 2026), любая светлая или неизвестная → -light (DEFAULT_THEME).
 *
 * Рантайм-страховка не отменяет этот скрипт: hydrateFromServer/store/uiPrefs.ts
 * и uiPreferencesSchema (packages/shared/src/schemas.ts) уже пропускают старый id
 * через migrateLegacyTheme на КАЖДОЕ чтение — то есть ничего не падает и без
 * бэкафилла. Скрипт нужен, чтобы запись в БД не расходилась с тем, что видит
 * пользователь (и чтобы будущий SELECT theme без разворота не возвращал старое
 * значение).
 *
 * Идемпотентен: агент, у кого theme уже "royal-home-2026-light"/"-night", не
 * попадает в выборку повторно.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx prisma/scripts/migrate-theme-2026.ts            — dry-run, ничего не пишет
 *     npx tsx prisma/scripts/migrate-theme-2026.ts --apply    — выполнить
 *
 * НЕ ЗАПУСКАТЬ НА ПРОДЕ из этой сессии — только локально/на объединённой ветке
 * перед деплоем слоя 4, и только после того, как владелец принял тему на проде
 * (внешнее условие §4.3 п.1 плана).
 */
import { prisma } from "../../src/db.js";
import { migrateLegacyTheme, THEME_IDS } from "@royal-home/shared";

/** Предел выборки — правило репозитория (docs/CLAUDE.md «Пагинация»). */
const LIMIT = 2000;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const agents = await prisma.agent.findMany({
    select: { id: true, fullName: true, preferences: true },
    orderBy: { createdAt: "asc" },
    take: LIMIT,
  });

  let touched = 0;

  for (const agent of agents) {
    const prefs = (agent.preferences ?? {}) as Record<string, unknown>;
    const rawTheme = typeof prefs.theme === "string" ? prefs.theme : undefined;

    // Уже валидный новый id — идемпотентность, ничего не трогаем.
    if (rawTheme && (THEME_IDS as readonly string[]).includes(rawTheme)) continue;

    const nextTheme = migrateLegacyTheme(rawTheme);

    console.log(`${agent.fullName} (${agent.id}): theme "${rawTheme ?? "(нет)"}" → "${nextTheme}"`);
    touched++;

    if (!apply) continue;

    await prisma.agent.update({
      where: { id: agent.id },
      data: { preferences: { ...prefs, theme: nextTheme } as never },
    });
  }

  console.log(
    apply
      ? `\nГотово: обновлено сотрудников — ${touched}.`
      : `\nПробный прогон: под перенос попадает сотрудников — ${touched}. Запустите с --apply, чтобы выполнить.`
  );
}

main()
  .catch((err) => {
    console.error("[migrate-theme-2026] упало:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
