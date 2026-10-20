/**
 * ПЕРЕСЧЁТ ОТБОРА КАНДИДАТОВ ПО ЖИВЫМ ДАННЫМ (разовый, 25.09.2026).
 *
 * Жалоба сотрудника, отбирающего кандидатов: «мне приходят и те, кому 23-24, и
 * те, кто где-то работают. В зелёных стоят электрики и женщины-домоседки».
 * Разбор прод-базы (25.09.2026, только чтение) нашёл три независимые причины:
 *
 *  1. Цвет ставила МОДЕЛЬ полем `priority` — и путала «есть какой-то опыт» с
 *     «опыт в продажах» (GREEN с причиной «без опыта в продажах»), «образование
 *     вообще» с «целевое образование» (YELLOW у электрика/учителя). Починка —
 *     в ai/jobApplication.ts (jobPriority теперь код, не модель, и `priority`/
 *     `priorityReason` ушли из схемы инструмента). Этот скрипт пересчитывает
 *     цвет по НОВЫМ правилам все анкетам разом — у старых строк, собранных до
 *     починки, нет salesExperience/targetEducation, так что расчёт идёт по
 *     ключевым словам в experience/education (та же jobPriority).
 *  2. Допуск (eligible) сам по себе не менялся — jobEligibility правилами не
 *     менялся ни разу за эту правку, пересчёт здесь просто ловит расхождение,
 *     если оно где-то накопилось (правки схемы, отладка).
 *  3. Анкета пишется на КАЖДЫЙ ход, где модель вернула поле jobApplication,
 *     НЕЗАВИСИМО от намерения разговора (messengers/conversation.ts, вызов
 *     recordJobApplication) — продавцы с рекламы «приёмка» и случайные «привет»
 *     попадают в кандидаты, если модель на этом ходе заодно заполнила анкету.
 *     Разбор: за 7 дней 72 анкеты, из них у разговора leadDraft.intent: job 29,
 *     sell 35, rent 3, other 4, buy 1. Статус NOT_CANDIDATE («не кандидат,
 *     ошибочно заведённая анкета») — новая стадия воронки (routes/vacancies.ts),
 *     исключённая из всех выдач и счётчиков раздела. Этот скрипт переводит в
 *     неё анкеты со status=NEW, чей диалог (BotConversation, тот же conversationId)
 *     не был ни про работу (leadDraft.intent !== "job"), ни с рекламы вакансии
 *     (adTopic !== "job"). Уже разобранные анкеты (status != NEW) НЕ трогаем —
 *     решение руководства по ним уже принято, отменять его задним числом нельзя.
 *
 * ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН: и цвет, и допуск — чистый пересчёт по текущим
 * полям (те же слова дают тот же результат), а NOT_CANDIDATE ставится только
 * статусу NEW — второй прогон не находит новых NEW среди уже переведённых.
 *
 * ЗАПУСК НА ПРОДЕ (из каталога репозитория на сервере, после выката, по
 * образцу lib/backfillJobApplications.ts / lib/askCandidatePhone.ts):
 *     docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
 *       node dist/lib/rescoreJobApplications.js            — показать, что изменится
 *     docker compose -f docker-compose.prod.yml --env-file .env.production exec api \
 *       node dist/lib/rescoreJobApplications.js --apply    — записать
 *
 * Почему в src/lib, а не в scripts/ — см. lib/backfillJobApplications.ts: в
 * прод-образе каталога scripts/ нет и tsx из него вырезан.
 */
import { pathToFileURL } from "node:url";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { channelPhoneForConversation } from "./jobApplications.js";
import { jobPriority, jobPriorityReason, jobEligibility, type JobPriority } from "../ai/jobApplication.js";
import { MANUAL_CANDIDATE_NOTE } from "./clientToCandidate.js";

const APPLY = process.argv.includes("--apply");

/** Предел выборки обязателен (правило репозитория) — анкет в разделе сотни,
 *  не миллионы; запас с потолком на будущий рост. */
const LIMIT = 5000;

interface ColorChange {
  id: string;
  who: string;
  from: JobPriority | null;
  to: JobPriority | null;
}
interface EligibleChange {
  id: string;
  who: string;
  from: boolean | null;
  to: boolean | null;
}
interface NotCandidateRow {
  id: string;
  who: string;
}

export interface RescoreResult {
  checked: number;
  colorChanges: ColorChange[];
  eligibleChanges: EligibleChange[];
  notCandidate: NotCandidateRow[];
  /** Анкеты status=NEW без conversationId или без найденного BotConversation —
   *  их нельзя проверить по leadDraft/adTopic (например, анкеты добора или
   *  Telegram-диалоги), поэтому они НЕ переводятся в NOT_CANDIDATE — пропуск,
   *  а не решение «это кандидат». */
  skippedNotCandidateCheck: number;
  /** Анкеты, которые руководитель перевёл в кандидаты сам кнопкой на карточке, —
   *  их NOT_CANDIDATE не касается, см. manuallyConverted. */
  skippedManual: number;
  /** Анкеты WhatsApp без номера, которым номер дописан из самого канала (wa_id) —
   *  HR 25.09.2026 «не вижу номера», см. channelPhoneForConversation. */
  phoneFilled: NotCandidateRow[];
}

/**
 * НОМЕР ИЗ КАНАЛА старым анкетам — тем же правилом, что и новым
 * (recordJobApplication): только там, где номера нет вовсе; напечатанный
 * кандидатом номер не перекрываем. `where` сужает выборку (тесты на общей базе).
 */
export async function fillChannelPhones(apply: boolean, where: Prisma.JobApplicationWhereInput = {}): Promise<NotCandidateRow[]> {
  const rows = await prisma.jobApplication.findMany({
    where: { AND: [where, { OR: [{ phone: null }, { phone: "" }] }, { NOT: { conversationId: null } }] },
    take: LIMIT,
    select: { id: true, name: true, contactName: true, conversationId: true, channel: true },
  });
  const filled: NotCandidateRow[] = [];
  for (const row of rows) {
    const phone = await channelPhoneForConversation(row.conversationId as string, row.channel);
    if (!phone) continue;
    filled.push({ id: row.id, who: row.name ?? row.contactName ?? row.id.slice(0, 8) });
    if (apply) await prisma.jobApplication.update({ where: { id: row.id }, data: { phone } });
  }
  return filled;
}

export async function rescoreJobApplications(apply: boolean): Promise<RescoreResult> {
  const rows = await prisma.jobApplication.findMany({
    take: LIMIT,
    select: {
      id: true,
      name: true,
      contactName: true,
      status: true,
      conversationId: true,
      clientId: true,
      age: true,
      studyingUniversity: true,
      studyingNow: true,
      employedNow: true,
      experience: true,
      education: true,
      salesExperience: true,
      targetEducation: true,
      hasCar: true,
      strongMotivation: true,
      priority: true,
      eligible: true,
    },
  });

  const result: RescoreResult = {
    checked: rows.length,
    colorChanges: [],
    eligibleChanges: [],
    notCandidate: [],
    skippedNotCandidateCheck: 0,
    skippedManual: 0,
    phoneFilled: [],
  };

  for (const row of rows) {
    const who = row.name ?? row.contactName ?? row.id.slice(0, 8);

    // ЦВЕТ — полный пересчёт по накопленной анкете (не «поднять», а ПЕРЕЗАПИСАТЬ,
    // см. шапку jobPriority): старая GREEN без единого слова о продажах здесь
    // честно уходит в null, а не остаётся висеть.
    const priorityInput = {
      experience: row.experience,
      education: row.education,
      salesExperience: row.salesExperience,
      targetEducation: row.targetEducation,
      hasCar: row.hasCar,
      strongMotivation: row.strongMotivation,
    };
    const nextPriority = jobPriority(priorityInput);
    const currentPriority = (row.priority as JobPriority | null) ?? null;
    if (nextPriority !== currentPriority) {
      result.colorChanges.push({ id: row.id, who, from: currentPriority, to: nextPriority });
    }

    // ДОПУСК — тем же кодом, что и бот (jobEligibility правилами не менялся);
    // пересчёт здесь ловит расхождение, если оно где-то накопилось.
    const nextEligible = jobEligibility({
      age: row.age,
      studyingUniversity: row.studyingUniversity,
      studyingNow: row.studyingNow,
      employedNow: row.employedNow,
    });
    if (nextEligible !== row.eligible) {
      result.eligibleChanges.push({ id: row.id, who, from: row.eligible, to: nextEligible });
    }

    if (apply) {
      const priorityReason = jobPriorityReason({ priority: nextPriority, ...priorityInput });
      await prisma.jobApplication.update({
        where: { id: row.id },
        data: { priority: nextPriority, priorityReason, eligible: nextEligible },
      });
    }
  }

  /**
   * NOT_CANDIDATE — только у NEW (уже разобранные статусы не трогаем, см. шапку
   * файла). Смотрим ТОЛЬКО BotConversation: JobApplication.conversationId — это
   * id из одной из трёх таблиц переписки без связи в схеме (тот же приём, что
   * profileIdForConversation в lib/jobApplications.ts), а leadDraft/adTopic есть
   * только у BotConversation — у Telegram-диалогов их нет вовсе, и такие анкеты
   * пропускаются, а не переводятся вслепую.
   */
  result.phoneFilled = await fillChannelPhones(apply);

  /**
   * ПЕРЕВЕДЁННЫХ РУКАМИ НЕ ТРОГАЕМ (02.10.2026). «В кандидаты» на карточке
   * (lib/clientToCandidate.ts) жмут ровно тогда, когда разговор шёл «про
   * покупку», а человек оказался соискателем, — и по правилу ниже такая анкета
   * пряталась бы в NOT_CANDIDATE назад. Признак ручного перевода — его событие в
   * хронологии карточки (MANUAL_CANDIDATE_NOTE); оно было и у переводов до этой
   * правки, так что старые анкеты узнаются тоже. Карточку берём у анкеты, а у
   * анкет, переведённых до 02.10.2026 (там clientId не ставился), — у диалога.
   */
  const manuallyConverted = new Set(
    (
      await prisma.interaction.findMany({
        where: { notes: MANUAL_CANDIDATE_NOTE },
        select: { clientId: true },
        take: LIMIT,
      })
    ).map((i) => i.clientId)
  );

  const newRows = rows.filter((r) => r.status === "NEW" && r.conversationId);
  for (const row of newRows) {
    const conv = await prisma.botConversation.findUnique({
      where: { id: row.conversationId as string },
      select: { leadDraft: true, adTopic: true, clientId: true },
    });
    if (!conv) {
      result.skippedNotCandidateCheck++;
      continue;
    }
    if (
      (row.clientId && manuallyConverted.has(row.clientId)) ||
      (conv.clientId && manuallyConverted.has(conv.clientId))
    ) {
      result.skippedManual++;
      continue;
    }
    const intent = (conv.leadDraft as { intent?: unknown } | null)?.intent;
    const isJobConversation = intent === "job" || conv.adTopic === "job";
    if (!isJobConversation) {
      const who = row.name ?? row.contactName ?? row.id.slice(0, 8);
      result.notCandidate.push({ id: row.id, who });
      if (apply) {
        await prisma.jobApplication.update({ where: { id: row.id }, data: { status: "NOT_CANDIDATE" } });
      }
    }
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rescoreJobApplications(APPLY)
    .then((r) => {
      console.log(`Проверено анкет: ${r.checked}.`);
      console.log(`${APPLY ? "Изменено" : "Изменилось бы"} цветов: ${r.colorChanges.length}.`);
      for (const c of r.colorChanges) console.log(`  ${c.who}: ${c.from ?? "нет цвета"} → ${c.to ?? "нет цвета"}`);
      console.log(`${APPLY ? "Изменено" : "Изменилось бы"} допусков: ${r.eligibleChanges.length}.`);
      for (const c of r.eligibleChanges) console.log(`  ${c.who}: ${String(c.from)} → ${String(c.to)}`);
      console.log(
        `${APPLY ? "Переведено" : "Перевелось бы"} в NOT_CANDIDATE (не про работу): ${r.notCandidate.length}.`
      );
      for (const c of r.notCandidate) console.log(`  ${c.who}`);
      if (r.skippedNotCandidateCheck > 0) {
        console.log(
          `Пропущено без проверки NOT_CANDIDATE (диалог не найден среди BotConversation — Telegram/добор): ${r.skippedNotCandidateCheck}.`
        );
      }
      if (r.skippedManual > 0) {
        console.log(`Оставлено кандидатами (переведены руководителем вручную): ${r.skippedManual}.`);
      }
      console.log(`${APPLY ? "Дописано" : "Дописалось бы"} номеров из WhatsApp: ${r.phoneFilled.length}.`);
      if (!APPLY) console.log("Записать — тот же запуск с --apply.");
    })
    .catch((err) => {
      console.error("Пересчёт анкет прерван:", err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
