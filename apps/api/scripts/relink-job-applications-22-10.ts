/**
 * РАЗОВАЯ ПРИВЯЗКА СТАРЫХ АНКЕТ К ВАКАНСИЯМ (22.10.2026, «Подбор сотрудников»).
 *
 * На проде 305 из 314 анкет без вакансии, у 99 не заполнены имя/возраст/опыт при
 * непустом рассказе. Скрипт:
 *  1. анкетам без customerInquiryId и без hrPositionKey ставит hrPositionKey
 *     (lib/vacancyPick.ts: слова про видео/SMM -> smm-videographer, иначе агент);
 *  2. анкетам с пустыми name/age/experience и непустым rawText или перепиской
 *     дозаполняет ТОЛЬКО пустые поля тем же ИИ-разбором, что и добор
 *     (lib/backfillJobApplications.ts -> extractFromHistory), затем пересчитывает
 *     priority/eligible теми же jobPriority/jobEligibility;
 *  3. печатает итог и список id, похожих на продавца/покупателя/услугу (статус не
 *     меняется, только отчёт).
 *
 * ЗАПУСК (из apps/api, там же .env с DATABASE_URL и ключом Gemini):
 *     npx tsx scripts/relink-job-applications-22-10.ts                 - план, ничего не пишет
 *     npx tsx scripts/relink-job-applications-22-10.ts --apply         - записать
 *     npx tsx scripts/relink-job-applications-22-10.ts --apply --no-ai - без шага 2
 *     ... --limit=100     - потолок анкет для ИИ-шага (по умолчанию 400)
 * Повторный запуск безопасен: заполняются только пустые поля.
 */
import { prisma } from "../src/db.js";
import { extractFromHistory, readMessages } from "../src/lib/backfillJobApplications.js";
import { jobEligibility, jobPriority, jobPriorityReason } from "../src/ai/jobApplication.js";
import { normalizeCandidatePhone } from "../src/lib/candidatePhone.js";
import {
  DEFAULT_VACANCY_KEY,
  SMM_VACANCY_KEY,
  looksLikeNonCandidate,
  pickVacancyKey,
} from "../src/lib/vacancyPick.js";

const APPLY = process.argv.includes("--apply");
const NO_AI = process.argv.includes("--no-ai");
const LIMIT = (() => {
  const raw = process.argv.find((a) => a.startsWith("--limit="));
  const n = raw ? Number.parseInt(raw.slice("--limit=".length), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : 400;
})();
const AI_CONCURRENCY = 3;
const AI_TIMEOUT_MS = 60_000;
const TAIL_MESSAGES = 10;

type Msg = { role: "user" | "assistant"; content: string };

/** Переписка анкеты: id диалога - из одной из трёх таблиц, связи в схеме нет. */
async function loadDialog(conversationId: string | null): Promise<Msg[]> {
  if (!conversationId) return [];
  const select = { messages: true } as const;
  const row =
    (await prisma.botConversation.findUnique({ where: { id: conversationId }, select })) ??
    (await prisma.telegramConversation.findUnique({ where: { id: conversationId }, select })) ??
    (await prisma.telegramDirectConversation.findUnique({ where: { id: conversationId }, select }));
  return row ? readMessages(row.messages) : [];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

async function main(): Promise<void> {
  console.log(APPLY ? "РЕЖИМ ЗАПИСИ (--apply)" : "РЕЖИМ ПЛАНА: база не изменится. Записать - добавьте --apply.");

  const keys = new Set((await prisma.recruitmentPosition.findMany({ select: { key: true } })).map((p) => p.key));
  for (const k of [DEFAULT_VACANCY_KEY, SMM_VACANCY_KEY]) {
    if (!keys.has(k)) throw new Error(`Вакансии «${k}» нет в базе - привязывать не к чему.`);
  }
  const keywords = await prisma.recruitmentKeyword.findMany({ select: { word: true, positionKey: true } });

  // Шаг 1. Привязка к вакансии
  const unlinked = await prisma.jobApplication.findMany({
    where: { customerInquiryId: null, hrPositionKey: null, customerPositionKey: null, status: { not: "NOT_CANDIDATE" } },
    select: { id: true, conversationId: true, rawText: true, experience: true, education: true },
  });
  console.log(`\nШаг 1. Анкет без вакансии: ${unlinked.length}`);
  const perPosition: Record<string, string[]> = {};
  for (const app of unlinked) {
    const dialog = await loadDialog(app.conversationId);
    const tail = dialog.slice(-TAIL_MESSAGES).map((m) => m.content);
    const text = [app.rawText, app.experience, app.education, ...tail].filter(Boolean).join("\n");
    const picked = pickVacancyKey(text, keywords);
    const key = keys.has(picked) ? picked : DEFAULT_VACANCY_KEY;
    (perPosition[key] ??= []).push(app.id);
  }
  for (const [key, ids] of Object.entries(perPosition)) {
    console.log(`  ${key}: ${ids.length}`);
    if (APPLY) {
      // where повторяет условие выбора: анкета, которой за время прогона уже
      // назначили вакансию руками, не перезаписывается.
      const res = await prisma.jobApplication.updateMany({
        where: { id: { in: ids }, hrPositionKey: null, customerPositionKey: null, customerInquiryId: null },
        data: { hrPositionKey: key },
      });
      console.log(`    записано: ${res.count}`);
    }
  }

  // Шаг 2. Дозаполнение пустых полей ИИ
  let filledCount = 0;
  let aiFailed = 0;
  let timedOut = 0;
  if (NO_AI) {
    console.log("\nШаг 2 пропущен (--no-ai).");
  } else {
    const candidates = await prisma.jobApplication.findMany({
      where: {
        status: { not: "NOT_CANDIDATE" },
        customerInquiryId: null,
        OR: [{ name: null }, { age: null }, { experience: null }],
        AND: [{ OR: [{ rawText: { not: null } }, { conversationId: { not: null } }] }],
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
    });
    console.log(`\nШаг 2. Анкет с пустыми имя/возраст/опыт: ${candidates.length} (ИИ, параллельно ${AI_CONCURRENCY})`);
    let consecutiveFails = 0;
    await pool(candidates, AI_CONCURRENCY, async (app) => {
      if (consecutiveFails >= 3) return;
      let dialog = await loadDialog(app.conversationId);
      if (dialog.length === 0 && app.rawText?.trim()) dialog = [{ role: "user", content: app.rawText.slice(0, 4000) }];
      if (dialog.length === 0) return;
      const result = await withTimeout(extractFromHistory(dialog), AI_TIMEOUT_MS);
      if (result === "timeout") {
        timedOut++;
        return;
      }
      if (result.kind === "ai-unavailable") {
        aiFailed++;
        consecutiveFails++;
        return;
      }
      consecutiveFails = 0;
      if (result.kind === "not-job") return;
      const d = result.draft;
      // Только пустые поля.
      const phone = !app.phone && d.phone ? normalizeCandidatePhone(d.phone) : undefined;
      const patch: Record<string, unknown> = {};
      const fill = (field: keyof typeof app, value: unknown) => {
        if (value !== undefined && value !== null && app[field] === null) patch[field] = value;
      };
      fill("name", d.name);
      fill("age", d.age);
      fill("experience", d.experience);
      fill("city", d.city);
      fill("education", d.education);
      fill("languages", d.languages);
      fill("startWhen", d.startWhen);
      fill("achievements", d.achievements);
      fill("hasCar", d.hasCar);
      fill("strongMotivation", d.strongMotivation);
      fill("salesExperience", d.salesExperience);
      fill("targetEducation", d.targetEducation);
      fill("studyingNow", d.studyingNow);
      fill("studyingUniversity", d.studyingUniversity);
      fill("employedNow", d.employedNow);
      if (phone) patch.phone = phone;
      if (Object.keys(patch).length === 0) return;

      // Пересчёт по ИТОГОВОЙ анкете (старое + дозаполненное), теми же функциями, что у бота.
      const merged = { ...app, ...patch } as typeof app;
      const priorityInput = {
        experience: merged.experience,
        education: merged.education,
        salesExperience: merged.salesExperience,
        targetEducation: merged.targetEducation,
        hasCar: merged.hasCar,
        strongMotivation: merged.strongMotivation,
      };
      const priority = jobPriority(priorityInput);
      if (priority !== null) {
        patch.priority = priority;
        patch.priorityReason = jobPriorityReason({ priority, ...priorityInput });
      }
      const eligible = jobEligibility(merged);
      if (eligible !== null) patch.eligible = eligible;

      filledCount++;
      console.log(`  ${app.id}: ${Object.keys(patch).join(", ")}`);
      if (APPLY) {
        // Условие updatedAt: анкету, которую за это время правил человек или бот, не трогаем.
        await prisma.jobApplication.updateMany({ where: { id: app.id, updatedAt: app.updatedAt }, data: patch });
      }
    });
    if (consecutiveFails >= 3) console.error("ИИ не отвечает (3 отказа подряд) - шаг 2 остановлен. Повторите запуск позже.");
  }

  // Шаг 3. Подозрительные на «не кандидат» (только отчёт)
  const all = await prisma.jobApplication.findMany({
    where: { status: { not: "NOT_CANDIDATE" }, customerInquiryId: null },
    select: { id: true, rawText: true, experience: true, education: true },
  });
  const reviewIds = all
    .filter((a) => looksLikeNonCandidate([a.rawText, a.experience, a.education].filter(Boolean).join("\n")))
    .map((a) => a.id);

  console.log("\n---- ИТОГ ----");
  for (const [key, ids] of Object.entries(perPosition)) console.log(`Привязано к «${key}»: ${ids.length}${APPLY ? "" : " (план)"}`);
  if (!NO_AI) {
    console.log(`Дозаполнено анкет: ${filledCount}${APPLY ? "" : " (план)"}; ИИ не ответил: ${aiFailed}; таймаут: ${timedOut}`);
  }
  console.log(`Похожи на продавца/покупателя/услугу (проверить руками, статус НЕ менялся): ${reviewIds.length}`);
  for (const id of reviewIds) console.log(`  ${id}`);
  if (!APPLY) console.log("\nНичего не записано (нет --apply).");
  if (aiFailed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
