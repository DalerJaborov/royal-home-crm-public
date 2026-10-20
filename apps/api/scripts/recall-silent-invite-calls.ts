/**
 * ПЕРЕЗВОНИТЬ КАНДИДАТАМ ПОСЛЕ НЕМЫХ ЗВОНКОВ (разовый, 03.10.2026).
 *
 * С 28.09 22:58 по 03.10 00:20 (Душанбе) у робота не было звука: кандидаты,
 * которым он звонил с приглашением на собеседование, слышали тишину. Разбор и
 * правила отбора — lib/silentInviteCalls.ts.
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL):
 *     npx tsx scripts/recall-silent-invite-calls.ts            — показать список, ничего не менять
 *     npx tsx scripts/recall-silent-invite-calls.ts --apply    — поставить звонки
 *
 * `--apply` — ТОЛЬКО по слову владельца в треде «Анкеты кандидатов»: робот
 * сам позвонит людям. Повторный запуск безопасен.
 */
import { prisma } from "../src/db.js";
import { findSilentInviteCalls, recallSilentInviteCalls } from "../src/lib/silentInviteCalls.js";
import { interviewTimeRu } from "../src/ai/interviewInviteCallPersona.js";

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  const calls = await findSilentInviteCalls();
  console.log(`Немых звонков, после которых собеседование ещё впереди: ${calls.length}`);
  for (const c of calls) {
    console.log(`  ${c.name} — ${interviewTimeRu(c.interviewAt)} (${c.was === "unclear" ? "ответ непонятен" : "не дозвонились"})`);
  }
  if (!apply) {
    console.log("Ничего не изменено. Поставить звонки: --apply");
    return;
  }
  const queued = await recallSilentInviteCalls(calls);
  console.log(`Поставлено звонков: ${queued}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
