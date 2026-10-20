/**
 * АУДИТ ПЕРЕПУТАННЫХ КАРТОЧЕК — ТОЛЬКО ЧТЕНИЕ (23.09.2026).
 *
 * Разовая проверка по просьбе владельца после случая «Мичгона» (кандидат в
 * вакансии, чётко описавшая дом на продажу, ушла заявкой на работу и
 * потеряна как продавец) — «сколько таких перепутанных». В базу НИЧЕГО НЕ
 * ПИШЕТ: список для просмотра владельцем, переносит он сам или по его слову.
 *
 * Что проверяет: анкеты кандидатов (JobApplication.rawText — все слова
 * кандидата одним текстом) на признак жилищной сделки тем же детектором, что
 * чинит саму ловушку (ai/housingIntent.ts::clientMeansHousingDeal, построен
 * 20.09.2026). Совпадение здесь не означает автоматически ошибку — детектор
 * ловит и «спасибо, жильё не нужно» (NOT_ABOUT_JOB), — но короткий список
 * стоит того, чтобы человек посмотрел глазами.
 *
 * Запуск из корня репозитория:
 *   npx tsx scripts/audit-miscategorized-leads-23-09.mjs
 * .env подхватывается из apps/api сам — руками экспортировать не нужно.
 */
import "./_env.cjs";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

import { prisma } from "../apps/api/src/db.js";
import { clientMeansHousingDeal } from "../apps/api/src/ai/housingIntent.js";

const OUT_PATH = resolve(process.cwd(), "docs/audit/miscategorized-leads-23-09.md");

async function main() {
  const applications = await prisma.jobApplication.findMany({
    select: {
      id: true,
      name: true,
      contactName: true,
      phone: true,
      channel: true,
      rawText: true,
      status: true,
      createdAt: true,
      conversationId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const suspects = applications.filter((a) => a.rawText && clientMeansHousingDeal(a.rawText));

  console.log(`Анкет кандидатов всего: ${applications.length}`);
  console.log(`Похожи на жилищную сделку (слова кандидата): ${suspects.length}`);
  console.log("");

  const lines = [
    "# Аудит: кандидаты, чьи слова похожи на жилищную сделку",
    "",
    `Собрано ${new Date().toISOString().slice(0, 10)}. Только чтение — в базу ничего не записано.`,
    "",
    `Анкет кандидатов всего: **${applications.length}**. Похожих на жилищную сделку: **${suspects.length}**.`,
    "",
    "Совпадение не означает автоматически ошибку — тот же детектор снимает и «жильё не нужно».",
    "Каждую строку стоит посмотреть глазами прежде, чем переносить карточку.",
    "",
    "| Анкета | Канал | Статус | Имя | Телефон | Создана | Текст кандидата (обрезан) |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of suspects) {
    const text = (s.rawText ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    lines.push(
      `| ${s.id} | ${s.channel} | ${s.status} | ${s.name ?? s.contactName ?? "—"} | ${s.phone ?? "—"} | ` +
        `${s.createdAt.toISOString().slice(0, 10)} | ${text}${text.length >= 160 ? "…" : ""} |`
    );
  }
  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
  console.log(`Список сохранён: ${OUT_PATH}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
