/**
 * ВЫПОЛНЕН на проде 08.09.2026 (docs/pult/theme-2026/reports/PROD-layer-4-backfill.md):
 * dry-run нашёл 0 сотрудников с ручной галочкой `properties.viewAll` — `--apply`
 * не требовался и не запускался. Слой 4 задача 6 удалила сам id из реестра
 * (`packages/shared/src/permissions.ts`) и строку совместимости в
 * `resolvePermissions` — этот файл больше не рантайм-код, оставлен только как
 * исторический артефакт (упомянут в layer-3-plan.md §2.1 и в backfill-отчёте
 * выше), не удаляется. Не включён в `apps/api/tsconfig.json` (`include: ["src"]`),
 * поэтому `properties.viewAll` в типе ниже не ломает сборку.
 *
 * BACKFILL: properties.viewAll → properties.viewOwners + properties.editForeign
 * (слой 3, 08.09.2026, docs/pult/theme-2026/layer-3-plan.md §2.1, задача 1).
 *
 * Предыстория. `properties.viewAll` разбито в реестре (packages/shared/src/
 * permissions.ts) на два права: «Контакты собственников» (`viewOwners`) и
 * «Правка чужих карточек объектов» (`editForeign`) — SECURITY и EDITOR должны
 * видеть собственника при проверке, но не иметь возможности сохранить чужую
 * карточку, а одна галочка раньше не могла это разделить. `resolvePermissions`
 * уже разворачивает старый id в оба новых РАНТАЙМОМ (см. permissions.ts) — этот
 * скрипт НЕ чинит доступ, доступ не терялся ни на секунду. Он нужен только для
 * того, чтобы экран «щит сотрудника» в Настройках сразу показывал обе новые
 * галочки включёнными у тех, кому `properties.viewAll` выдали ЛИЧНО (в
 * Agent.permissions.granted, поверх пресета роли) — иначе администратор увидит
 * две новые пустые галочки у человека, который явно имел право, и решит, что
 * что-то потерялось.
 *
 * Кого трогает: только Agent, у кого granted (ручная надстройка) содержит
 * "properties.viewAll" — то есть право выдано ЛИЧНО, не через пресет роли.
 * Пресеты ролей (ROLE_PRESETS в permissions.ts) правятся отдельно, кодом, не
 * этим скриптом, и уже переведены на новые id.
 *
 * Что делает: дописывает "properties.viewOwners" и "properties.editForeign" в
 * тот же granted, СТАРЫЙ id "properties.viewAll" не удаляет (пока флаг слоя 4
 * не снят — см. план §4, порядок операций там же).
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx prisma/scripts/migrate-properties-view-all.ts            — dry-run, ничего не пишет
 *     npx tsx prisma/scripts/migrate-properties-view-all.ts --apply    — выполнить
 *
 * НЕ ЗАПУСКАТЬ НА ПРОДЕ из этой сессии — только локально, на своей БД, для
 * проверки перед деплоем слоя 3 (правило CLAUDE.md «подтверждения на прод по
 * одной» + план §2.4 риск 4: снижение объёма прав у SECURITY/EDITOR с ручной
 * галочкой — директор должен быть предупреждён списком до выката).
 *
 * Идемпотентен: повторный запуск не находит работы там, где оба новых id уже
 * есть в granted.
 */
import { prisma } from "../../src/db.js";
import { parsePermissionOverrides, ROLE_PRESETS, type PermissionId, type Role } from "@royal-home/shared";

/** Предел выборки — правило репозитория. Ручных granted-надстроек единицы. */
const LIMIT = 500;

const OLD_ID: PermissionId = "properties.viewAll";
const NEW_IDS: PermissionId[] = ["properties.viewOwners", "properties.editForeign"];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const candidates = await prisma.agent.findMany({
    where: {
      // JSON-фильтр по массиву внутри granted: агент, кому properties.viewAll
      // выдано личным granted, а не только через пресет роли.
      permissions: { path: ["granted"], array_contains: [OLD_ID] },
    },
    select: { id: true, fullName: true, role: true, permissions: true },
    orderBy: { createdAt: "asc" },
    take: LIMIT,
  });

  let touched = 0;
  const roleWarnings: string[] = [];

  for (const agent of candidates) {
    const overrides = parsePermissionOverrides(agent.permissions);
    if (!overrides.granted.includes(OLD_ID)) continue; // фильтр БД мог зацепить лишнее — перепроверяем в коде

    const missing = NEW_IDS.filter((id) => !overrides.granted.includes(id));
    if (missing.length === 0) continue; // уже дозаписано — идемпотентность

    const nextGranted = [...new Set([...overrides.granted, ...missing])];

    console.log(
      `${agent.fullName} (${agent.role}, ${agent.id}): дописать в granted — ${missing.join(", ")}`
    );
    touched++;

    // Предупреждение владельцу (план §2.4 риск 4): у роли, чей ПРЕСЕТ больше не
    // содержит properties.viewAll/editForeign (SECURITY, EDITOR), это ручное
    // право явно выдавали сверх пресета — то есть человеку сознательно открыли
    // ПОЛНЫЙ объём; backfill сохраняет то же значение, только двумя id вместо
    // одного, ничего не снижает. Строка ниже — просто чтобы это было видно в
    // выводе явно, а не терялось в общем списке.
    const presetIds: readonly string[] = ROLE_PRESETS[agent.role as Role] ?? [];
    if (!presetIds.includes(OLD_ID)) {
      roleWarnings.push(`  — ${agent.fullName}: право было выдано личной галочкой сверх пресета роли ${agent.role}`);
    }

    if (!apply) continue;

    await prisma.agent.update({
      where: { id: agent.id },
      data: { permissions: { ...(agent.permissions as object), granted: nextGranted } as never },
    });
  }

  if (roleWarnings.length > 0) {
    console.log("\nЛичные надстройки поверх пресета роли (объём доступа не меняется, только форма записи):");
    for (const line of roleWarnings) console.log(line);
  }

  console.log(
    apply
      ? `\nГотово: обновлено сотрудников — ${touched}.`
      : `\nПробный прогон: под перенос попадает сотрудников — ${touched}. Запустите с --apply, чтобы выполнить.`
  );
}

main()
  .catch((err) => {
    console.error("[migrate-properties-view-all] упало:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
