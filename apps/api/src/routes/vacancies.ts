/**
 * Раздел «Вакансии» — анкеты кандидатов, собранные ботом в переписке.
 *
 * Решение владельца 16.08.2026: раздел для руководителя и администратора
 * (право vacancies.view, входит в пресеты MANAGER и ADMIN). Обычному агенту
 * чужие кандидаты не видны — и в меню раздела у него нет.
 *
 * Записи создаёт только бот (lib/jobApplications.ts). Здесь — чтение и решение.
 *
 * ВОРОНКА РАСШИРЕНА 31.08.2026 (разбор ATS-практик, владелец: «доработай раздел
 * полностью, продумай, что с карточками при отказе/собеседовании/найме»). Было
 * 4 плоских статуса без дат и причин — стало 6 стадий линейного пайплайна плюс
 * поля, которые в них появляются:
 *   NEW → REVIEWED → INTERVIEW (нужна interviewAt) → INTERVIEWED → HIRED (hiredAt
 *   выставляется сам) — и REJECTED (обычно с rejectionReason), достижим с любой
 *   нетерминальной стадии, не только с конца очереди.
 * INVITED переименован в INTERVIEW миграцией данных — смысл прежний.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { customerRecruitmentPortfolioSchema, recruitmentResumeSchema, recruitmentScreeningRulesSchema, assessRecruitmentResume } from "@royal-home/shared";
import { recruitmentPositionsRouter } from "./recruitmentPositions.js";
import { recruitmentCommunicationsRouter } from "./recruitmentCommunications.js";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import {
  enqueueInterviewInviteCallTx,
  interviewInviteRefusal,
  interviewInviteStatusText,
} from "../lib/interviewInviteCall.js";
import { logAudit } from "../lib/audit.js";
import { loadBotCapabilities } from "../messengers/botCapabilities.js";
import { TG_PREFIX } from "./conversations.js";
import { presentMessages } from "../lib/messageAttachments.js";
import { can } from "../auth/middleware.js";
import { normalizeCandidatePhone } from "../lib/candidatePhone.js";
import { jobMissingFacts, jobPriority, jobPriorityReason, jobRejectReasons } from "../ai/jobApplication.js";
import { maskPhoneRaw } from "../lib/phoneCrypto.js";
import { eraseJobApplicationsTx, removeCandidateFiles } from "../lib/candidateErase.js";
import {
  isDialableTajikNumber,
  loadAgentDialMode,
  loadAriCredentials,
  originateCall,
  resolveAgentDialTarget,
} from "../lib/telephony/ariClient.js";
import { beginOrigination, endOrigination, hasLiveCall } from "../lib/telephony/callTracker.js";
import type { Prisma } from "../generated/prisma/client.js";
import { dushanbeDayRange } from "../lib/dushanbeTime.js";
import { sendPrivateFile } from "../lib/sendPrivateFile.js";
import { r2PresignDownloadUrl } from "../lib/r2Client.js";
import {
  BUCKET_FIT,
  BUCKET_INCOMPLETE,
  BUCKET_REJECTED,
  BUCKET_WHERE,
  EFFECTIVELY_REJECTED,
  HAS_PHONE,
  NOT_ARCHIVED,
  NO_PHONE,
  PASSES_FILTER,
} from "../lib/vacancyVisibility.js";

export const vacanciesRouter = Router();
vacanciesRouter.use("/positions", recruitmentPositionsRouter);
vacanciesRouter.use(recruitmentCommunicationsRouter);

/** Стадии воронки. Закрытый список: свободная строка в поле статуса превращает
 *  очередь в свалку, по которой нельзя фильтровать. Порядок — как в пайплайне,
 *  REJECTED последним: фронту так удобнее рисовать линейный прогресс. */
const STATUSES = ["NEW", "REVIEWED", "INTERVIEW", "INTERVIEWED", "HIRED", "REJECTED"] as const;

/**
 * СТАТУС ДЛЯ PATCH — шире, чем `STATUSES` (25.09.2026, разбор жалобы «в
 * кандидатах продавцы с рекламы приёмки»). NOT_CANDIDATE — «не кандидат,
 * ошибочно заведённая анкета» (разговор оказался не про работу вообще:
 * продавец объекта, реклама, случайное «привет»). Он НАРОЧНО не входит в
 * `STATUSES`: тот список используется и для фильтра списка, и для сводки
 * `counts` — а NOT_CANDIDATE обязан быть исключён из ОБОИХ, не просто вечным
 * нулём в них (см. NOT_ARCHIVED ниже). PATCH — единственное место, которое
 * должно уметь ПОСТАВИТЬ этот статус.
 */
const PATCH_STATUSES = [...STATUSES, "NOT_CANDIDATE"] as const;

/** Стадии, для которых обязательно своё поле — без него статус ничего не говорит
 *  руководству о том, что делать дальше (правило владельца 31.08.2026). Ключ шире
 *  VacancyStatus — PATCH принимает и NOT_CANDIDATE, для него требования нет. */
const STATUS_REQUIRES: Partial<Record<(typeof PATCH_STATUSES)[number], "interviewAt">> = {
  INTERVIEW: "interviewAt",
};

/** Служебное значение фильтра вакансии: анкеты без вакансии. */
const NO_POSITION = "__none";
/** Канал анкеты, добавленной сотрудником вручную. */
const MANUAL_CHANNEL = "MANUAL";

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  /**
   * Показывать ли отсеянных обязательным фильтром (моложе 24 или учится в вузе).
   *
   * По умолчанию НЕТ: смысл фильтра в том, чтобы руководство разбирало тех, кого
   * реально зовут, а не листало мимо всех подряд. Но и удалять такие анкеты нельзя
   * — человек написал нам по-настоящему, обстоятельства меняются, и через год он
   * подойдёт. Поэтому они лежат рядом и открываются одним признаком.
   */
  includeFiltered: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Показывать ли анкеты БЕЗ НОМЕРА ТЕЛЕФОНА.
   *
   * По умолчанию НЕТ (решение владельца 03.09.2026: «у кого нет телефона, не надо
   * кидать в CRM — без телефона мы не знаем, как с ними связываться»). Бот теперь
   * обязан спрашивать номер и переспрашивать, если не дали (SCENARIO_JOB), поэтому
   * анкета без номера — это разговор, оборвавшийся раньше времени, а не кандидат
   * в очередь.
   *
   * Но и стирать их нельзя: человек написал по-настоящему, переписка жива, и
   * ответить ему можно прямо в ней. Поэтому они лежат рядом и открываются одним
   * признаком — ровно как отсеянные обязательным отбором.
   */
  includeNoPhone: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Поиск по очереди: имя, телефон, город, опыт, образование (владелец
   * 03.09.2026: «фильтров, чтобы работало всё, удобно и быстро»). Ищем на
   * СЕРВЕРЕ, а не в загруженном куске: выборка ограничена пределом, и фильтрация
   * на фронте молча искала бы только по первой сотне.
   */
  q: z.string().trim().max(80).optional(),
  activeOnly: z.enum(["true", "false"]).optional().transform(value => value === "true"),
  /** "__none" - только анкеты без вакансии (нет ни customerPositionKey, ни hrPositionKey). */
  positionKey: z.union([z.literal(NO_POSITION), z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)]).optional(),
  /**
   * Цвет отбора — самая частая нарезка очереди: «покажи только с опытом продаж».
   * NONE — те, у кого цвета ещё нет (бот не спросил про опыт): это тоже
   * осмысленный отбор, а не отсутствие фильтра, и в интерфейсе он назван
   * «Опыт не выяснен».
   */
  priority: z.enum(["GREEN", "YELLOW", "RED", "NONE"]).optional(),
  /**
   * ТРИ КОРЗИНЫ ОТБОРА (владелец 25.09.2026) — то же самое поле `eligible`, но
   * названо словами, которыми думает сотрудник, разбирающий очередь: «прошёл»,
   * «ещё не решено», «отсеян». Без параметра — ПРЕЖНЕЕ поведение (includeFiltered/
   * includeNoPhone решают видимость, как раньше): старый фронт ничего не
   * присылает и не должен сломаться. С параметром — bucket сам решает видимость
   * по eligible, включая отсеянных и без оглядки на includeFiltered.
   */
  bucket: z.enum(["fit", "incomplete", "rejected"]).optional(),
  // Предел выборки обязателен: роут, возвращающий массив без предела, растёт
  // молча вместе с базой (правило репозитория).
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

/** Язык переписки (ru/tg) живёт в досье — по нему HR видит, на каком языке
 *  человек пишет, и по нему же робозвонок выбирает голос. Последний
 *  звонок-приглашение — строка «Робот позвонил: придёт» в анкете; skipReason —
 *  чтобы строка называла точную причину, почему робот не звонил. */
const LIST_INCLUDE = {
  customerPosition: { select: { titleRu: true, titleTg: true, screeningRules: true } },
  hrPosition: { select: { titleRu: true, titleTg: true, screeningRules: true } },
  customerInquiry: { select: { publicState: true } },
  contactProfile: { select: { language: true } },
  inviteCalls: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: {
      status: true,
      outcome: true,
      proposedTime: true,
      summary: true,
      interviewAt: true,
      talkedAt: true,
      skipReason: true,
      recordingKey: true,
    },
  },
} satisfies Prisma.JobApplicationInclude;

/**
 * Строка робота в анкете. Ключ записи наружу не отдаётся — только «запись есть»
 * (слушают через GET /:id/invite-call-recording).
 *
 * ПРО ПРЕЖНЕЕ ВРЕМЯ (проверка робота 02.10.2026). HR перенёс собеседование, не
 * поставив галочку робота, — последний звонок остаётся про старое время, и
 * анкета показывала «Робот позвонил: придёт», хотя о новом времени кандидат не
 * знает. Такой итог больше не выдаётся за ответ про текущее собеседование.
 */
export function presentInviteCall(
  call: ListRow["inviteCalls"][number] | undefined,
  app: { status: string; interviewAt: Date | null }
) {
  if (!call) return null;
  const { recordingKey, ...rest } = call;
  const hasRecording = !!recordingKey;
  if (["PENDING", "NO_ANSWER"].includes(call.status)) return { ...rest, hasRecording,
    text: "Нужно подготовить новое приглашение: проверьте вакансию, время и каналы связи" };
  const stale =
    app.status === "INTERVIEW" &&
    !!app.interviewAt &&
    call.interviewAt.getTime() !== app.interviewAt.getTime() &&
    (call.status === "DONE" || call.status === "GIVEN_UP");
  if (stale) {
    return {
      ...rest,
      outcome: null,
      proposedTime: null,
      summary: null,
      hasRecording,
      text: "Робот звонил про прежнее время — о новом кандидату не сообщали, позвоните ему сами",
    };
  }
  return { ...rest, hasRecording, text: interviewInviteStatusText(call) };
}

/** Предел блока «Сегодня»: собеседований в день у нас единицы. */
const TODAY_LIMIT = 50;

type ListRow = Prisma.JobApplicationGetPayload<{ include: typeof LIST_INCLUDE }>;

/** Строка списка в том виде, в каком её ждёт экран. inboxId — готовая ссылка на
 *  переписку (правило склейки живёт рядом с инбоксом); missing/rejectReasons —
 *  тем же кодом, что решает допуск (ai/jobApplication.ts). */
function presentListItem({ contactProfile, inviteCalls, customerPosition, hrPosition, customerInquiry, customerApplicationRevision, ...i }: ListRow) {
  const portfolio = customerRecruitmentPortfolioSchema.safeParse(i.customerPortfolio);
  const resume = recruitmentResumeSchema.safeParse(i.recruitmentResume);
  const selectedPosition = customerPosition ?? hrPosition;
  const rules = recruitmentScreeningRulesSchema.safeParse(selectedPosition?.screeningRules);
  const state = customerInquiry?.publicState;
  const coreLanguage = state && typeof state === "object" && !Array.isArray(state) && (state.language === "ru" || state.language === "tg") ? state.language : null;
  return {
    ...i,
    customerApplicationRevision: customerApplicationRevision?.toString() ?? null,
    customerPortfolio: portfolio.success ? portfolio.data : [],
    positionTitle: selectedPosition?.titleRu ?? null,
    positionKey: i.customerPositionKey ?? i.hrPositionKey,
    recruitmentResume: resume.success ? resume.data : null,
    recruitmentAssessment: assessRecruitmentResume({ rules: rules.success ? rules.data : null,
      facts: resume.success ? resume.data.facts : {}, name: i.name, phone: i.phone,
      portfolioCount: (portfolio.success ? portfolio.data.length : 0) + (i.cvFile ? 1 : 0),
      values: i.customerInquiryId ? undefined : { age: i.age,
        studyingNow: i.studyingNow === true || i.studyingUniversity === true ? true : i.studyingNow ?? i.studyingUniversity,
        employedNow: i.employedNow, city: i.city, experience: i.experience, education: i.education,
        languages: i.languages, startWhen: i.startWhen, about: i.rawText },
    }),
    chatLanguage: coreLanguage ?? contactProfile?.language ?? null,
    inviteCall: presentInviteCall(inviteCalls[0], i),
    inboxId: inboxIdOf(i.channel, i.conversationId),
    missing: i.customerInquiryId ? [] : jobMissingFacts(i),
    rejectReasons: i.customerInquiryId ? [] : jobRejectReasons(i),
  };
}

vacanciesRouter.get("/", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const { status, limit, offset, includeFiltered, includeNoPhone, q, priority, bucket, activeOnly, positionKey } = parsed.data;
  const statusWhere = status ? { status } : activeOnly ? { status: { notIn: ["HIRED", "REJECTED"] } } : {};
  const priorityWhere = priority ? (priority === "NONE" ? { priority: null } : { priority }) : {};
  /**
   * NOT_CANDIDATE — «не кандидат, ошибочно заведённая анкета» (владелец
   * 25.09.2026) — исключается из АБСОЛЮТНО ВСЕХ выдач и счётчиков этого роута,
   * безусловно и даже если кто-то явно запросит `status=NOT_CANDIDATE`: этот
   * статус вообще не входит в `STATUSES` (список для фильтра и для сводки), а
   * тут закрывается и путь в обход фильтра — через прямой where по статусу.
   * Единственная ручка, которая ЕГО ставит, — PATCH ниже.
   */
  // NOT_ARCHIVED, HAS_PHONE, NO_PHONE, PASSES_FILTER и корзины — из
  // lib/vacancyVisibility.ts: те же условия считают сайдбар и пульт (02.10.2026).

  /**
   * УСЛОВИЯ СОБИРАЮТСЯ СПИСКОМ, А НЕ РАССЫПАЮТСЯ ПО ОБЪЕКТУ (баг, найденный
   * владельцем 03.09.2026: «нажимаешь одно — выходит другое»).
   *
   * Здесь стояло три спреда подряд, и два из них клали в объект ОДИН И ТОТ ЖЕ
   * ключ `AND`: поиск и требование телефона. В объектном литерале выживает
   * последний — поиск молча исчезал, а список отвечал так, будто в строку ничего
   * не вводили. То же самое случилось бы со вторым `OR` рядом с условием допуска.
   *
   * Поэтому все ограничения складываются в ОДИН массив `AND`: сколько бы их ни
   * стало, они не могут затереть друг друга — ни сейчас, ни при следующей правке.
   */
  /**
   * eligible=null — допуск ещё не решён (бот не успел спросить про возраст,
   * учёбу или работу): такие показываем, иначе разговор, оборвавшийся на
   * середине, исчезал бы вместе с кандидатом.
   *
   * УСЛОВИЕ ПИШЕТСЯ СПИСКОМ ЗНАЧЕНИЙ, А НЕ ОТРИЦАНИЕМ (найдено на проде
   * 03.09.2026). Здесь стояло `NOT: { eligible: false }`, что уходит в SQL как
   * `NOT (eligible = false)`. Для NULL это выражение даёт не «истину», а NULL, и
   * строка в выборку НЕ попадает — то есть отрицание молча выбросило ровно тех,
   * кого комментарий обещал показывать. В базе лежало 14 анкет: 2 отсеянных и 12
   * с невыясненным допуском, а раздел показывал ноль. (PASSES_FILTER — в
   * lib/vacancyVisibility.ts, там же учтено «Всё равно позвать».)
   */
  /**
   * Поиск идёт по тем полям, в которых человек и станет искать: имя (своё и из
   * профиля мессенджера), телефон, город, опыт, образование. insensitive —
   * потому что «зарина» и «Зарина» для ищущего одно и то же.
   */
  const qDigits = (q ?? "").replace(/\D/g, "");
  const searchWhere = q
    ? {
        OR: [
          { name: { contains: q, mode: "insensitive" as const } },
          { contactName: { contains: q, mode: "insensitive" as const } },
          { phone: { contains: q, mode: "insensitive" as const } },
          // Номер ищется по цифрам: пробелы, скобки и плюс в запросе не мешают.
          ...(qDigits.length >= 3 ? [{ phone: { contains: qDigits } }] : []),
          { city: { contains: q, mode: "insensitive" as const } },
          { experience: { contains: q, mode: "insensitive" as const } },
          { education: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : null;

  /**
   * КОРЗИНА ОТБОРА ПОВЕРХ eligible (владелец 25.09.2026). Без bucket — старое
   * поведение: includeFiltered решает, показывать ли eligible=false. С bucket —
   * он САМ называет нужное значение eligible, включая rejected (то, что
   * includeFiltered раньше прятал по умолчанию), и includeFiltered на выдачу
   * больше не влияет — bucket однозначнее.
   */
  /**
   * ТЕЛЕФОН — ЧЕТВЁРТАЯ ПРОВЕРКА КОРЗИНЫ, А НЕ ОТДЕЛЬНЫЙ ПЕРЕКЛЮЧАТЕЛЬ (сборка
   * 25.09.2026). «Подходят — звонить» без номера — пустое обещание, а скрыть
   * такого кандидата вовсе значило потерять его: он прошёл отбор, но ни в одной
   * корзине не виден. Поэтому прошедший без номера лежит в «Дособрать» (бот ещё
   * просит номер), а includeNoPhone при заданной корзине больше ничего не решает.
   */
  const bucketFilter = bucket ? BUCKET_WHERE[bucket] : null;
  const eligibilityFilter = bucketFilter ?? (includeFiltered ? null : PASSES_FILTER);
  // Добавленные вручную кандидаты (POST /) видны и без номера: телефон в форме
  // необязателен, и новая карточка не должна исчезать из ленты сразу после создания.
  const phoneFilter = bucket || includeNoPhone ? [] : [{ OR: [HAS_PHONE, { channel: MANUAL_CHANNEL }] }];

  /** Ограничения, общие для списка и для всех счётчиков рядом с ним. Счётчики
   *  обязаны считать по тому же поиску: иначе кнопка обещает «Отсеянные (7)», а
   *  показывает двоих, подходящих под строку поиска. NOT_ARCHIVED — первым и
   *  безусловно: ни один запрос этого роута не должен видеть NOT_CANDIDATE. */
  // Вакансия анкеты на экране = customerPositionKey ?? hrPositionKey (presentListItem),
  // фильтр и счётчики positionCounts считают её ровно так же.
  const positionWhere =
    positionKey === NO_POSITION
      ? [{ customerPositionKey: null, hrPositionKey: null }]
      : positionKey
        ? [{ OR: [{ customerPositionKey: positionKey }, { customerPositionKey: null, hrPositionKey: positionKey }] }]
        : [];
  const common = [NOT_ARCHIVED, ...positionWhere, ...(searchWhere ? [searchWhere] : []), ...(priority ? [priorityWhere] : [])];
  const visible = [
    ...common,
    ...(eligibilityFilter ? [eligibilityFilter] : []),
    ...phoneFilter,
  ];
  /**
   * То же самое, но БЕЗ фильтра по цвету — для чисел рядом с самими цветами.
   * Без этого «Опыт продаж (4)» превращался бы в «(4)» только пока выбран этот
   * же цвет, а у остальных стояли бы нули: выбор нельзя показывать так, будто
   * выбирать больше нечего (жалоба владельца 03.09.2026 «кнопки не работают» —
   * ровно про такую слепоту: цвет без кандидатов ничем не отличался от
   * сломанной кнопки).
   */
  const visibleAnyPriority = [
    NOT_ARCHIVED,
    ...positionWhere,
    ...(searchWhere ? [searchWhere] : []),
    ...(eligibilityFilter ? [eligibilityFilter] : []),
    ...phoneFilter,
  ];
  /** Для чисел рядом с вакансиями: те же фильтры этапа/поиска/цвета, но БЕЗ фильтра вакансии. */
  const visibleAnyPosition = [
    NOT_ARCHIVED,
    ...(searchWhere ? [searchWhere] : []),
    ...(priority ? [priorityWhere] : []),
    ...(eligibilityFilter ? [eligibilityFilter] : []),
    ...phoneFilter,
  ];

  // «Сегодня» на экране — все собеседования этого дня по Душанбе, а не только
  // попавшие в загруженную страницу (02.10.2026: старый кандидат с собеседованием
  // сегодня не попадал в первые `limit` строк и пропадал из блока, хотя в сводке
  // стадий числился). Без поиска, корзины и цвета: это расписание дня, а не нарезка.
  const today = dushanbeDayRange(new Date());

  const [
    items,
    total,
    todayRows,
    filteredCount,
    noPhoneCount,
    byStatus,
    byPriority,
    bucketFit,
    bucketIncomplete,
    bucketRejected,
    byPosition,
    capabilities,
  ] = await Promise.all([
    prisma.jobApplication.findMany({
      where: { ...statusWhere, AND: visible },
      // Новые сверху: предел выборки должен отсекать старое, а не случайное.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
      include: LIST_INCLUDE,
    }),
    // Сколько всего под текущим фильтром — экран пишет «Показаны N из M» и даёт
    // «Показать ещё», а не обрезает список молча на сотой строке.
    prisma.jobApplication.count({ where: { ...statusWhere, AND: visible } }),
    prisma.jobApplication.findMany({
      where: { AND: [NOT_ARCHIVED, { status: "INTERVIEW" }, { interviewAt: { gte: today.start, lt: today.end } }] },
      orderBy: { interviewAt: "asc" },
      take: TODAY_LIMIT,
      include: LIST_INCLUDE,
    }),
    prisma.jobApplication.count({ where: { ...statusWhere, AND: [...common, EFFECTIVELY_REJECTED] } }),
    prisma.jobApplication.count({ where: { ...statusWhere, AND: [...common, NO_PHONE] } }),
    /**
     * СВОДКА ПО СТАДИЯМ — она же навигация (владелец 03.09.2026: «сделай более
     * удобный дашборд»). Считается по тем же правилам видимости, что и список,
     * но БЕЗ фильтра по статусу: иначе, выбрав «Новая», человек увидел бы в
     * сводке одну цифру и не смог бы понять, куда идти дальше.
     */
    prisma.jobApplication.groupBy({
      by: ["status"],
      _count: { _all: true },
      // Без фильтра по статусу: сводка — это навигация, и, выбрав одну стадию,
      // человек должен по-прежнему видеть, сколько кандидатов на остальных.
      where: { AND: visible },
    }),
    prisma.jobApplication.groupBy({
      by: ["priority"],
      _count: { _all: true },
      where: { ...statusWhere, AND: visibleAnyPriority },
    }),
    /**
     * bucketCounts — те же три числа, что byStatus считает по стадиям, только
     * по eligible: сколько прошло (fit), сколько ещё не решено (incomplete),
     * сколько отсеяно (rejected). Считаются по `common` (поиск, цвет, статус,
     * без NOT_CANDIDATE) — БЕЗ фильтра по самому bucket и БЕЗ HAS_PHONE, тем же
     * приёмом, что filteredCount/noPhoneCount выше: это счётчики-подсказки для
     * переключателя, они не должны зависеть от того, какая вкладка сейчас
     * открыта, и от наличия телефона.
     */
    prisma.jobApplication.count({ where: { ...statusWhere, AND: [...common, BUCKET_FIT] } }),
    prisma.jobApplication.count({ where: { ...statusWhere, AND: [...common, BUCKET_INCOMPLETE] } }),
    prisma.jobApplication.count({ where: { ...statusWhere, AND: [...common, BUCKET_REJECTED] } }),
    prisma.jobApplication.groupBy({
      by: ["customerPositionKey", "hrPositionKey"],
      _count: { _all: true },
      where: { ...statusWhere, AND: visibleAnyPosition },
    }),
    // Отказ базы здесь трактуется так же, как в самом боте (ALL_ENABLED): «собирает».
    loadBotCapabilities(),
  ]);
  /**
   * ЗЕЛЁНЫЕ СВЕРХУ (правила отбора владельца 16.08.2026): кандидата с опытом продаж
   * зовут первым, и он не должен тонуть под вчерашними красными.
   *
   * Порядок задаётся здесь, а не в SQL: в базе лежит слово, и алфавит дал бы
   * GREEN → RED → YELLOW, то есть худших выше средних. Заводить числовую колонку
   * ради трёх значений незачем — выборка и так ограничена пределом.
   */
  const rank = { GREEN: 0, YELLOW: 1, RED: 2 } as const;
  const ordered = [...items].sort(
    (a, b) =>
      (rank[a.priority as keyof typeof rank] ?? 3) - (rank[b.priority as keyof typeof rank] ?? 3) ||
      b.createdAt.getTime() - a.createdAt.getTime()
  );
  res.json({
    // Строки — см. presentListItem выше. total — сколько всего под текущим
    // фильтром (items — первые `limit` из них); todayInterviews — расписание дня
    // целиком, независимо от загруженной страницы.
    // The résumé queue is chronological across pages. Retain color ordering
    // only for explicit older bucket clients; it is not a hiring decision.
    items: (bucket ? ordered : items).map(presentListItem),
    total,
    offset,
    todayInterviews: todayRows.map(presentListItem),
    filteredCount,
    noPhoneCount,
    // Плоский словарь стадия → сколько: фронту не приходится знать про форму
    // ответа groupBy, а отсутствующая стадия честно равна нулю. NOT_CANDIDATE
    // сюда никогда не попадает: его нет в STATUSES (см. её шапку).
    counts: Object.fromEntries(STATUSES.map((st) => [st, byStatus.find((g) => g.status === st)?._count._all ?? 0])),
    /** Сколько кандидатов каждого цвета — число стоит прямо в списке выбора,
     *  поэтому пустой цвет виден ДО нажатия, а не после. */
    priorityCounts: {
      GREEN: byPriority.find((g) => g.priority === "GREEN")?._count._all ?? 0,
      YELLOW: byPriority.find((g) => g.priority === "YELLOW")?._count._all ?? 0,
      RED: byPriority.find((g) => g.priority === "RED")?._count._all ?? 0,
      NONE: byPriority.find((g) => g.priority === null)?._count._all ?? 0,
    },
    /** Сколько анкет у каждой вакансии (ключ вакансии, "__none" - без вакансии) при
     *  текущих фильтрах этапа/поиска/цвета, но БЕЗ фильтра вакансии. */
    positionCounts: positionCountsOf(byPosition),
    /** Те же корзины, что и параметр bucket выше — прошёл / не решено / отсеян. */
    bucketCounts: { fit: bucketFit, incomplete: bucketIncomplete, rejected: bucketRejected },
    collecting: capabilities.vacancies,
  });
});

/** Свёртка groupBy по (customerPositionKey, hrPositionKey) в словарь «вакансия -> число». */
function positionCountsOf(
  groups: Array<{ customerPositionKey: string | null; hrPositionKey: string | null; _count: { _all: number } }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) {
    const key = g.customerPositionKey ?? g.hrPositionKey ?? NO_POSITION;
    out[key] = (out[key] ?? 0) + g._count._all;
  }
  return out;
}

/** Идентификатор того же диалога в инбоксе («Сообщения»). null — анкета без
 *  переписки (такие бывают только у добора, см. lib/backfillJobApplications.ts)
 *  или переписка, которой в инбоксе нет: личные сообщения Telegram
 *  (TELEGRAM_DIRECT, своя таблица TelegramDirectConversation) инбокс не
 *  показывает вовсе, и ссылка открыла бы чужой или пустой диалог. */
function inboxIdOf(channel: string, conversationId: string | null): string | null {
  if (!conversationId) return null;
  if (channel === "TELEGRAM_DIRECT") return null;
  return channel === "TELEGRAM" ? TG_PREFIX + conversationId : conversationId;
}

/**
 * ПЕРЕПИСКА КАНДИДАТА — ТЕКСТ И ТО, ЧТО ОН ПРИСЛАЛ ФАЙЛОМ.
 *
 * Владелец 03.09.2026: «переписки не видно, надо чтобы мы могли перейти на
 * переписку; и что делать, если они отправляют резюме файлом или в документе».
 * Резюме приходит вложением и в анкету не попадает никогда — модель кладёт в
 * поля только слова. Поэтому анкета сама по себе неполна: без вложений
 * руководство не видит присланного PDF и считает, что кандидат ничего не прислал.
 *
 * Ручка отдаёт последние реплики и отдельным списком — ФАЙЛЫ САМОГО КАНДИДАТА
 * (реплики role=user). Права те же, что в инбоксе: сам текст видит тот, кому
 * открыт раздел, а имена файлов — только с `messages.viewAttachments`; телефон
 * внутри текста — с `clients.viewPhone` (см. lib/messageAttachments.ts).
 */
const CONVERSATION_TAIL = 60;

vacanciesRouter.get("/:id/conversation", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const application = await prisma.jobApplication.findUnique({
    where: { id: req.params.id },
    select: { conversationId: true, channel: true, status: true, clientId: true,
      customerInquiry: { select: { conversationId: true, telegramConversationId: true, telegramDirectConversationId: true } } },
  });
  // NOT_CANDIDATE — «анкету завели по ошибке» (продавец, покупатель): раздел
  // такую анкету не показывает нигде, и её переписка — это переписка КЛИЕНТА,
  // открывать её по праву вакансий нельзя (02.10.2026). Тот же ответ, что на
  // «нет анкеты»: перебором id нельзя выяснить, что она была.
  if (!application || application.status === "NOT_CANDIDATE") {
    return res.status(404).json({ error: "Анкета не найдена" });
  }
  const inquiry = application.customerInquiry;
  const conversationId = application.conversationId ?? inquiry?.conversationId ?? inquiry?.telegramConversationId ?? inquiry?.telegramDirectConversationId;
  if (!conversationId) {
    // Анкета без диалога — не ошибка: показываем пустую переписку, а не 404,
    // иначе экран нарисовал бы отказ там, где просто нечего показывать.
    return res.json({ inboxId: null, messages: [], files: [] });
  }

  // Три таблицы переписки — по каналу анкеты. TELEGRAM_DIRECT — личные
  // сообщения Telegram (messengers/telegramDirectMessages.ts): своя таблица, и
  // раньше такая анкета читала BotConversation по чужому id и показывала пустоту.
  const select = { messages: true, clientId: true } as const;
  const raw =
    (application.channel === "TELEGRAM" || !!inquiry?.telegramConversationId)
      ? await prisma.telegramConversation.findUnique({ where: { id: conversationId }, select })
      : (application.channel === "TELEGRAM_DIRECT" || !!inquiry?.telegramDirectConversationId)
        ? await prisma.telegramDirectConversation.findUnique({ where: { id: conversationId }, select })
        : await prisma.botConversation.findUnique({ where: { id: conversationId }, select });
  if (!raw) return res.json({ inboxId: null, messages: [], files: [] });

  /**
   * Номер в тексте КАНДИДАТА не маскируется (жалоба HR 25.09.2026: «не вижу
   * номера»). Маска clients.viewPhone защищает базу КЛИЕНТОВ агентства от ухода
   * вместе с сотрудником; кандидат на работу клиентом не является, а тот, кому
   * открыт раздел вакансий, обязан ему позвонить — номер из анкеты он и так
   * видит полем. Прятать тот же номер в переписке значило только путать.
   *
   * НО ТОЛЬКО ПОКА ЭТО ПРАВДА КАНДИДАТ (02.10.2026). Диалог, привязанный к
   * карточке покупателя или продавца, — это переписка клиента, в которой
   * человек заодно спросил про работу: в ней номера клиента и тех, о ком он
   * пишет. Там маска действует как в инбоксе — без clients.viewPhone номера
   * скрыты. Карточка «Другое» (OTHER) — это и есть кандидат, переведённый из
   * клиентов (lib/clientToCandidate.ts).
   */
  const clientIds = [...new Set([raw.clientId, application.clientId].filter((v): v is string => !!v))];
  const clientCards =
    clientIds.length > 0
      ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { kind: true } })
      : [];
  const isRealClient = clientCards.some((c) => c.kind !== "OTHER");
  const phonesAllowed = !isRealClient || can(req, "clients.viewPhone");
  const messages = presentMessages(raw.messages, can(req, "messages.viewAttachments"), phonesAllowed).slice(
    -CONVERSATION_TAIL
  );

  res.json({
    inboxId: inboxIdOf(application.channel, conversationId),
    messages,
    // Файлы отдельно и только кандидатские: наши же фотографии объектов, которые
    // бот отправлял в этот диалог, к резюме отношения не имеют и только мешали бы.
    files: messages.filter((m) => m.role === "user").flatMap((m) => m.attachments ?? []),
  });
});

/**
 * РЕЗЮМЕ КАНДИДАТА (02.10.2026). Раньше кнопка «Открыть файл» шла в общий
 * /attachments/:name, а там право messages.viewAttachments (у руководителя —
 * главного HR — его в пресете нет) и сверка владельца по КАРТОЧКЕ КЛИЕНТА,
 * которой у кандидата нет: и руководитель, и HR без clients.viewAll получали
 * отказ. Здесь право — то же, что у самого раздела, а отдаётся ТОЛЬКО файл,
 * записанный в cvFile этой анкеты: имя из адреса не принимается вовсе, значит
 * этим путём нельзя достать ни чужое вложение, ни голосовую заметку.
 */
vacanciesRouter.get("/:id/cv", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const application = await prisma.jobApplication.findUnique({
    where: { id: req.params.id },
    select: { cvFile: true, status: true },
  });
  // NOT_CANDIDATE — переписка клиента, а не кандидата (см. /:id/conversation).
  if (!application || application.status === "NOT_CANDIDATE" || !application.cvFile) {
    return res.status(404).json({ error: "Файл не найден" });
  }
  if (!sendPrivateFile(res, application.cvFile, "vacancy-cv")) {
    return res.status(404).json({ error: "Файл не найден" });
  }
});

vacanciesRouter.get("/:id/portfolio/:index", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const params = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0).max(23) }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Неверный файл" });
  const application = await prisma.jobApplication.findUnique({ where: { id: params.data.id }, select: { status: true, customerPortfolio: true } });
  const parsed = customerRecruitmentPortfolioSchema.safeParse(application?.customerPortfolio);
  const file = parsed.success ? parsed.data[params.data.index] : null;
  if (!application || application.status === "NOT_CANDIDATE" || !file || !("file" in file) ||
      !sendPrivateFile(res, file.file, "vacancy-portfolio")) return res.status(404).json({ error: "Файл не найден" });
});

/**
 * Запись последнего разговора робота с кандидатом (проверка робота 02.10.2026:
 * анкета говорила «послушайте разговор», а послушать было негде). Ссылка в R2 на
 * 10 минут, запрашивается заново при каждом нажатии — как у записей живого
 * голоса в Настройках.
 */
vacanciesRouter.get(
  "/:id/invite-call-recording",
  requireAuth,
  requirePermission("vacancies.view"),
  async (req, res) => {
    const call = await prisma.interviewInviteCall.findFirst({
      // Последний звонок — тот, чью строку HR видит в анкете (presentInviteCall).
      where: { jobApplicationId: req.params.id, jobApplication: { status: { not: "NOT_CANDIDATE" } } },
      orderBy: { createdAt: "desc" },
      select: { recordingKey: true },
    });
    if (!call?.recordingKey) return res.status(404).json({ error: "Записи нет" });
    const url = await r2PresignDownloadUrl(call.recordingKey);
    if (!url) return res.status(502).json({ error: "Хранилище записей не ответило" });
    res.json({ url });
  }
);

/** Адрес голосовой заметки — ровно то, что выдаёт POST /me/voice-notes. */
const VOICE_NOTE_URL_RE = /^\/me\/voice-notes\/[0-9a-f-]{36}\.[a-z0-9]{2,4}$/i;

const patchSchema = z
  .object({
    // PATCH_STATUSES, не STATUSES: только здесь можно ПОСТАВИТЬ NOT_CANDIDATE
    // (см. её шапку) — список/сводка его не фильтруют и не показывают вовсе.
    status: z.enum(PATCH_STATUSES).optional(),
    positionKey: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
    // null разрешён явно — так очищают дату/заметку, назначенную по ошибке.
    // undefined не сериализуется в JSON (правило репозитория): чтобы очистить
    // поле, фронт обязан прислать null, а не просто не передать ключ.
    interviewAt: z.string().datetime({ offset: true }).nullable().optional(),
    interviewNote: z.string().max(2000).nullable().optional(),
    rejectionReason: z.string().max(500).nullable().optional(),
    // Только адрес, который выдаёт наша же запись голосовой заметки
    // (POST /me/voice-notes → /me/voice-notes/<uuid>.<ext>, routes/me.ts).
    // Экран проигрывает его через api() с токеном смотрящего, и свободная строка
    // увела бы этот запрос на любой путь API (02.10.2026).
    rejectionReasonVoiceUrl: z.string().regex(VOICE_NOTE_URL_RE, "Неверная ссылка на голосовую заметку").nullable().optional(),
    rejectionReasonVoiceTranscript: z.string().max(4000).nullable().optional(),
    talentPool: z.boolean().optional(),
    /**
     * ПРАВКА ТЕЛЕФОНА (найдено 04.09.2026, полный обход раздела): у бота
     * телефон теперь единственное поле, решающее, попадёт ли анкета в
     * очередь (HAS_PHONE ниже), а поправить его, если бот записал криво или
     * кандидат прислал верный номер позже устно, было НЕЧЕМ — ни этого поля
     * в схеме, ни формы на фронте. Тот же normalizeCandidatePhone, что и у
     * бота (lib/candidatePhone.ts): вручную вбитый мусор отклоняем так же
     * честно, как отклонили бы придуманный моделью.
     */
    phone: z.string().max(40).nullable().optional(),
    /**
     * «Робот позвонит и пригласит» (владелец 25.09.2026): вместе с назначением
     * собеседования ставит звонок кандидату (lib/interviewInviteCall.ts).
     * Работает только с итоговым статусом INTERVIEW и датой.
     */
    inviteCall: z.boolean().optional(),
    /**
     * «Всё равно позвать» (02.10.2026): руководитель берёт кандидата в работу
     * вопреки автоматическому отбору. Хранится отдельно от eligible (бот его
     * пересчитывает каждым ходом), корзины и счётчики читают оба поля —
     * lib/vacancyVisibility.ts. false или null снимают решение.
     */
    eligibleOverride: z.boolean().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Пустой запрос" });

vacanciesRouter.patch("/:id", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  if (body.inviteCall === true) return res.status(400).json({
    error: "Подготовьте приглашение с предпросмотром и выберите SMS или звонок ассистента.",
    code: "RECRUITMENT_PREVIEW_REQUIRED",
  });

  const existing = await prisma.jobApplication.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Анкета не найдена" });
  if (body.positionKey !== undefined) {
    if (existing.customerInquiryId) return res.status(409).json({ error: "Вакансия этой анкеты связана с обращением нового ядра." });
    const position = await prisma.recruitmentPosition.findUnique({ where: { key: body.positionKey }, select: { key: true } });
    if (!position) return res.status(400).json({ error: "Выберите существующую вакансию" });
  }

  // interviewAt — либо валидная дата, либо явный null (очистка), либо не пришла
  // вовсе (оставляем как было).
  let interviewAt: Date | null | undefined;
  if (body.interviewAt !== undefined) {
    if (body.interviewAt === null) {
      interviewAt = null;
    } else {
      const d = new Date(body.interviewAt);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "Неверная дата собеседования" });
      }
      interviewAt = d;
    }
  }

  // Стадия INTERVIEW без даты не говорит руководству, что и когда делать дальше
  // (правило владельца 31.08.2026) — проверяем ИТОГОВУЮ пару: статус и дата из
  // этого же запроса или уже сохранённые раньше. Не только при смене статуса:
  // `{interviewAt: null}` без статуса оставлял INTERVIEW без даты (02.10.2026).
  //
  // Только когда запрос трогает статус или дату (доразбор 02.10.2026): иначе
  // правка номера или заметки у старой анкеты INTERVIEW без даты отвечала 400,
  // хотя к дате собеседования этот запрос отношения не имеет.
  const finalStatus = (body.status ?? existing.status) as (typeof PATCH_STATUSES)[number];
  const finalAt = interviewAt !== undefined ? interviewAt : existing.interviewAt;
  const touchesInterview = body.status !== undefined || body.interviewAt !== undefined;
  if (touchesInterview && STATUS_REQUIRES[finalStatus] === "interviewAt" && !finalAt) {
    return res.status(400).json({ error: "Укажите дату и время собеседования" });
  }

  // Телефон — либо очистка (null), либо нормализованный номер, либо честный
  // отказ: человек ввёл что-то нецелое, и молча отбрасывать ввод здесь нельзя
  // так же, как у модели — это прямое действие живого администратора.
  let phone: string | null | undefined;
  if (body.phone !== undefined) {
    if (body.phone === null || body.phone.trim() === "") {
      phone = null;
    } else {
      const normalized = normalizeCandidatePhone(body.phone);
      if (!normalized) return res.status(400).json({ error: "Неверный номер телефона" });
      phone = normalized;
    }
  }

  const data: Record<string, unknown> = { reviewedById: req.agent!.id };
  if (body.positionKey !== undefined) data.hrPositionKey = body.positionKey;
  if (body.status) data.status = body.status;
  if (interviewAt !== undefined) data.interviewAt = interviewAt;
  if (body.interviewNote !== undefined) data.interviewNote = body.interviewNote;
  if (body.rejectionReason !== undefined) data.rejectionReason = body.rejectionReason;
  if (body.rejectionReasonVoiceUrl !== undefined) data.rejectionReasonVoiceUrl = body.rejectionReasonVoiceUrl;
  if (body.rejectionReasonVoiceTranscript !== undefined)
    data.rejectionReasonVoiceTranscript = body.rejectionReasonVoiceTranscript;
  if (body.talentPool !== undefined) data.talentPool = body.talentPool;
  if (phone !== undefined) {
    data.phone = phone;
    // Staff correction belongs to the HR application, not a new claim about
    // the customer's canonical identity. Later bot turns must preserve it.
    data.recruitmentPhoneOverride = true;
  }
  // Только true хранится как решение; false/null — «решения нет» (null), чтобы
  // у снятого и никогда не ставившегося было одно значение.
  if (body.eligibleOverride !== undefined) data.eligibleOverride = body.eligibleOverride === true ? true : null;
  // Дата выхода на работу выставляется один раз, самим переходом в HIRED — не
  // полем формы: реальную дату выхода никто не помнит точнее, чем «сегодня»,
  // когда статус меняют, а повторный PATCH (например, правка заметки) не должен
  // сдвигать её вперёд.
  if (body.status === "HIRED" && !existing.hiredAt) data.hiredAt = new Date();
  // Ушли с HIRED (ошибочно отметили принятым) — дата выхода больше не правда.
  if (existing.status === "HIRED" && body.status && body.status !== "HIRED") data.hiredAt = null;

  // Звонок-приглашение — проверяется ДО записи: отказ не должен оставлять
  // наполовину применённую правку. Только итоговая стадия INTERVIEW с датой в
  // будущем. Робот не сможет позвонить (нет номера, выключен, поздно, уже
  // звонил про это время) — собеседование всё равно сохраняется, звонок не
  // ставится, и HR видит inviteCallNote: звонить ему самому (02.10.2026, раньше
  // такие звонки молча гасли, а экран обещал «робот позвонит»).
  let inviteAt: Date | null = null;
  let inviteCallNote: string | null = null;
  if (body.inviteCall) {
    if (finalStatus !== "INTERVIEW" || !finalAt || finalAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Робот зовёт только на назначенное собеседование в будущем" });
    }
    const refusal = await interviewInviteRefusal({
      jobApplicationId: req.params.id,
      interviewAt: finalAt,
      phone: phone !== undefined ? phone : existing.phone,
    });
    if (refusal) inviteCallNote = refusal.note;
    else inviteAt = finalAt;
  }

  // Анкета ушла со стадии собеседования или время сменили без нового звонка —
  // ждущий звонок гаснет в той же записи, иначе карточка продолжала бы
  // говорить «Робот позвонит» про собеседование, которого нет.
  const timeChanged =
    interviewAt !== undefined && (interviewAt?.getTime() ?? null) !== (existing.interviewAt?.getTime() ?? null);
  const cancelWaiting = finalStatus !== "INTERVIEW" || (timeChanged && !inviteAt);

  // Анкета и звонок — одной транзакцией: отказ любой из записей не оставляет
  // сохранённое собеседование с обещанным, но не поставленным звонком.
  // updateMany вместо update: гонка с параллельным удалением/сменой не превращает
  // это в необработанное исключение Prisma — 404 остаётся честным ответом.
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "JobApplication" WHERE "id"=${req.params.id} FOR UPDATE`;
    if (body.status !== undefined || body.interviewAt !== undefined || body.phone !== undefined || body.positionKey !== undefined) {
      const active = await tx.recruitmentCommunication.count({ where: { jobApplicationId: req.params.id,
        channel: "ASSISTANT_CALL", status: { in: ["IN_FLIGHT", "ACCEPTED"] } } });
      if (active) return "calling" as const;
    }
    const result = await tx.jobApplication.updateMany({ where: { id: req.params.id, updatedAt: existing.updatedAt }, data });
    if (result.count === 0) return false;
    if (cancelWaiting) {
      await tx.interviewInviteCall.updateMany({
        where: { jobApplicationId: req.params.id, status: { in: ["PENDING", "NO_ANSWER"] } },
        data: { status: "CANCELLED" },
      });
    }
    if (inviteAt) {
      await enqueueInterviewInviteCallTx(tx, {
        jobApplicationId: req.params.id,
        interviewAt: inviteAt,
        requestedById: req.agent!.id,
      });
    }
    return true;
  });
  if (saved === "calling") return res.status(409).json({ error: "Ассистент сейчас говорит с кандидатом. Дождитесь результата звонка перед изменением вакансии, телефона или встречи." });
  if (!saved) return res.status(409).json({ error: "Анкета уже изменилась. Обновите её и повторите действие." });
  /**
   * ЖУРНАЛ НАЗЫВАЕТ, ЧТО ИМЕННО ПОМЕНЯЛИ (02.10.2026). Раньше любая правка —
   * телефон, время собеседования, звонок робота — писалась как «смена этапа»
   * с одинаковыми from/to, и по журналу нельзя было понять, кто перенёс
   * собеседование или поправил номер. Теперь: этап сменился — VACANCY_STATUS
   * (с остальными правками в том же событии), не сменился — VACANCY_UPDATE со
   * списком полей. Ничего не поменялось — записи нет. Сам номер в журнал не
   * пишется: журнал видят шире, чем анкету.
   */
  const changes = vacancyPatchChanges(existing, data, { inviteQueued: !!inviteAt });
  const statusChanged = body.status !== undefined && body.status !== existing.status;
  if (statusChanged || changes.fields.length > 0) {
    logAudit(req, statusChanged ? "VACANCY_STATUS" : "VACANCY_UPDATE", "JobApplication", req.params.id, {
      ...(statusChanged ? { from: existing.status, to: body.status } : {}),
      ...changes.meta,
      ...(changes.fields.length > 0 ? { fields: changes.fields } : {}),
    });
  }

  res.json({ ok: true, inviteCallQueued: !!inviteAt, ...(inviteCallNote ? { inviteCallNote } : {}) });
});

/** Поля анкеты, которые меняет PATCH, кроме самой стадии. */
const AUDITED_FIELDS = [
  "hrPositionKey",
  "interviewAt",
  "interviewNote",
  "rejectionReason",
  "rejectionReasonVoiceUrl",
  "talentPool",
  "phone",
  "eligibleOverride",
] as const;

/** Что реально поменялось — для журнала. Сравнение по значению: повторное
 *  сохранение того же номера или той же даты правкой не считается. */
function vacancyPatchChanges(
  existing: Record<string, unknown>,
  data: Record<string, unknown>,
  robot: { inviteQueued: boolean }
): { fields: string[]; meta: Record<string, unknown> } {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));
  const fields = AUDITED_FIELDS.filter((f) => f in data && norm(data[f]) !== norm(existing[f]));
  const meta: Record<string, unknown> = {};
  if (fields.includes("interviewAt")) {
    meta.interviewAt = { from: norm(existing.interviewAt), to: norm(data.interviewAt) };
  }
  if (fields.includes("eligibleOverride")) meta.eligibleOverride = data.eligibleOverride === true;
  if (fields.includes("phone")) meta.phoneChanged = true;
  const result = { fields: [...fields] as string[], meta };
  if (robot.inviteQueued) {
    result.fields.push("inviteCall");
    meta.inviteCallQueued = true;
  }
  return result;
}

/**
 * ПОЗВОНИТЬ КАНДИДАТУ ЧЕРЕЗ СТАНЦИЮ (владелец 29.09.2026: «хочу позвонить
 * кандидату по HR из админки — выходит tel:+992…, станция не соединяет»).
 *
 * До этого у анкеты не было своего звонка: кнопка отдавала голую ссылку tel:,
 * и набирал ЛИЧНЫЙ телефон того, кто нажал, мимо АТС. Теперь — тот же путь, что
 * у звонка коллеге (routes/agents.ts, POST /:id/call): сначала звонит трубка
 * сотрудника (софтфон, браузер или мобильный — resolveAgentDialTarget), потом
 * станция набирает кандидата. Карточку клиента под кандидата НЕ заводим (как это
 * сделал бы ручной набор /clients/dial) — кандидат не клиент, и лишняя карточка
 * попала бы в воронку и в отчёты.
 */
vacanciesRouter.post("/:id/call", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const application = await prisma.jobApplication.findUnique({
    where: { id: req.params.id },
    select: { name: true, phone: true, status: true },
  });
  if (!application || application.status === "NOT_CANDIDATE") return res.status(404).json({ error: "Анкета не найдена" });
  if (!application.phone) return res.status(409).json({ error: "Кандидат ещё не дал телефон" });
  if (!isDialableTajikNumber(application.phone)) {
    return res.status(409).json({ error: "Номер кандидата не таджикский — станция его не наберёт" });
  }

  const me = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { sipExtension: true, phone: true } });
  if (!me?.sipExtension) {
    return res.status(409).json({ error: "У вас не настроен внутренний номер (SIP) — обратитесь к директору" });
  }
  if (hasLiveCall(req.agent!.id) || !beginOrigination(req.agent!.id)) {
    return res.status(409).json({ error: "У вас уже идёт звонок — завершите его, прежде чем начать новый" });
  }
  try {
    const creds = await loadAriCredentials();
    if (!creds) return res.status(409).json({ error: "Телефония не настроена — нет ключей ARI в Настройках" });
    const caller = await resolveAgentDialTarget(creds, me.sipExtension, me.phone, await loadAgentDialMode());
    const result = await originateCall(creds, me.sipExtension, application.phone, {
      callerName: `Кандидат ${application.name ?? ""}`.trim(),
      agentMobile: caller.agentMobile,
    });
    if (!result.ok) return res.status(502).json({ error: result.error ?? "Не удалось позвонить" });
    res.json({ ok: true, channelId: result.channelId });
  } finally {
    endOrigination(req.agent!.id);
  }
});

/** Удаление навсегда - только для директора и администратора. */
function canEraseCandidates(role: string): boolean {
  return role === "DIRECTOR" || role === "ADMIN";
}

const ACTIVE_CALL_STATUSES = ["IN_FLIGHT", "ACCEPTED"];

type SkipReason = "not_found" | "calling" | "customer_inquiry";
type SkippedItem = { id: string; reason: SkipReason };

/**
 * РУЧНОЕ ДОБАВЛЕНИЕ КАНДИДАТА (22.10.2026). Анкета создаётся сразу с вакансией
 * (hrPositionKey), каналом MANUAL и стадией NEW. Телефон нормализуется тем же
 * кодом, что у бота; тот же номер у существующей анкеты - 409 с её id. Допуск
 * (eligible) не считается: возраст и учёбу руководитель знает сам, а отсеять
 * вручную добавленного человека автоматикой значило бы спрятать его из ленты.
 */
const createSchema = z.object({
  name: z.string().trim().min(1, "Укажите имя").max(120),
  phone: z.string().max(40).nullish(),
  positionKey: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  city: z.string().trim().max(120).nullish(),
  age: z.number().int().min(14).max(90).nullish(),
  experience: z.string().trim().max(2000).nullish(),
  note: z.string().trim().max(2000).nullish(),
});

vacanciesRouter.post("/", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const position = await prisma.recruitmentPosition.findUnique({ where: { key: body.positionKey }, select: { key: true } });
  if (!position) return res.status(400).json({ error: "Выберите существующую вакансию" });

  let phone: string | null = null;
  if (body.phone && body.phone.trim() !== "") {
    const normalized = normalizeCandidatePhone(body.phone);
    if (!normalized) return res.status(400).json({ error: "Неверный номер телефона" });
    phone = normalized;
    const duplicate = await prisma.jobApplication.findFirst({
      where: { AND: [{ phone }, NOT_ARCHIVED] },
      select: { id: true },
    });
    if (duplicate) return res.status(409).json({ error: "Такой кандидат уже есть", existingId: duplicate.id });
  }

  const experience = body.experience || null;
  const priority = jobPriority({ experience });
  const created = await prisma.jobApplication.create({
    data: {
      channel: MANUAL_CHANNEL,
      name: body.name,
      phone,
      city: body.city || null,
      age: body.age ?? null,
      experience,
      interviewNote: body.note || null,
      hrPositionKey: body.positionKey,
      status: "NEW",
      reviewedById: req.agent!.id,
      ...(priority !== null ? { priority, priorityReason: jobPriorityReason({ priority, experience }) } : {}),
    },
    include: LIST_INCLUDE,
  });
  logAudit(req, "VACANCY_CREATE", "JobApplication", created.id, {
    channel: MANUAL_CHANNEL,
    positionKey: body.positionKey,
    ...(phone ? { phone: maskPhoneRaw(phone) } : {}),
  });
  res.status(201).json(presentListItem(created));
});

/** Стирает анкеты насовсем (общая часть DELETE /:id и bulk delete). */
async function eraseApplications(
  req: Request,
  ids: string[]
): Promise<{ updated: number; skipped: SkippedItem[] }> {
  const done = await prisma.$transaction(async (tx) => {
    const rows = await tx.jobApplication.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, status: true, customerPositionKey: true, hrPositionKey: true },
    });
    const busy = await tx.recruitmentCommunication.findMany({
      where: { jobApplicationId: { in: ids }, channel: "ASSISTANT_CALL", status: { in: ACTIVE_CALL_STATUSES } },
      select: { jobApplicationId: true },
    });
    const busyIds = new Set(busy.map((b) => b.jobApplicationId));
    const known = new Set(rows.map((r) => r.id));
    const skipped: SkippedItem[] = [
      ...ids.filter((id) => !known.has(id)).map((id) => ({ id, reason: "not_found" as const })),
      ...rows.filter((r) => busyIds.has(r.id)).map((r) => ({ id: r.id, reason: "calling" as const })),
    ];
    const erased = rows.filter((r) => !busyIds.has(r.id));
    const files = await eraseJobApplicationsTx(tx, erased.map((r) => r.id));
    return { erased, skipped, files };
  });
  for (const row of done.erased) {
    logAudit(req, "VACANCY_DELETE", "JobApplication", row.id, {
      name: row.name,
      status: row.status,
      positionKey: row.customerPositionKey ?? row.hrPositionKey,
      ...(row.phone ? { phone: maskPhoneRaw(row.phone) } : {}),
    });
  }
  // Файлы - после коммита; сбой пишется в журнал ошибок и ответ не меняет.
  void removeCandidateFiles(done.files);
  return { updated: done.erased.length, skipped: done.skipped };
}

/** Удалить кандидата НАВСЕГДА вместе с зависимыми записями и файлами. */
vacanciesRouter.delete("/:id", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  if (!canEraseCandidates(req.agent!.role)) {
    return res.status(403).json({ error: "Удалять анкеты навсегда может только директор или администратор" });
  }
  const { skipped } = await eraseApplications(req, [req.params.id]);
  if (skipped[0]?.reason === "not_found") return res.status(404).json({ error: "Анкета не найдена" });
  if (skipped[0]?.reason === "calling") {
    return res.status(409).json({ error: "Ассистент сейчас говорит с кандидатом. Дождитесь результата звонка." });
  }
  res.status(204).end();
});

/** Массовые действия над анкетами (до 200 за раз). */
const bulkSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(200),
    action: z.enum(["assignPosition", "setStatus", "delete"]),
    positionKey: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/).optional(),
    status: z.enum(["NEW", "REVIEWED", "REJECTED", "NOT_CANDIDATE"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "assignPosition" && !v.positionKey) {
      ctx.addIssue({ code: "custom", message: "Укажите вакансию", path: ["positionKey"] });
    }
    if (v.action === "setStatus" && !v.status) {
      ctx.addIssue({ code: "custom", message: "Укажите этап", path: ["status"] });
    }
  });

vacanciesRouter.post("/bulk", requireAuth, requirePermission("vacancies.view"), async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { action, positionKey, status } = parsed.data;
  const ids = [...new Set(parsed.data.ids)];

  if (action === "delete") {
    if (!canEraseCandidates(req.agent!.role)) {
      return res.status(403).json({ error: "Удалять анкеты навсегда может только директор или администратор" });
    }
    return res.json(await eraseApplications(req, ids));
  }

  if (action === "assignPosition") {
    const position = await prisma.recruitmentPosition.findUnique({ where: { key: positionKey! }, select: { key: true } });
    if (!position) return res.status(400).json({ error: "Выберите существующую вакансию" });
  }

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.jobApplication.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, customerInquiryId: true },
    });
    const busy = await tx.recruitmentCommunication.findMany({
      where: { jobApplicationId: { in: ids }, channel: "ASSISTANT_CALL", status: { in: ACTIVE_CALL_STATUSES } },
      select: { jobApplicationId: true },
    });
    const busyIds = new Set(busy.map((b) => b.jobApplicationId));
    const known = new Set(rows.map((r) => r.id));
    const skipped: SkippedItem[] = ids.filter((id) => !known.has(id)).map((id) => ({ id, reason: "not_found" as const }));
    const ok: typeof rows = [];
    for (const row of rows) {
      if (busyIds.has(row.id)) skipped.push({ id: row.id, reason: "calling" });
      // Вакансия новых анкет (customerPositionKey) принадлежит ядру - руками не меняем.
      else if (action === "assignPosition" && row.customerInquiryId) skipped.push({ id: row.id, reason: "customer_inquiry" });
      else ok.push(row);
    }
    const okIds = ok.map((r) => r.id);
    if (okIds.length > 0) {
      if (action === "assignPosition") {
        await tx.jobApplication.updateMany({
          where: { id: { in: okIds } },
          data: { hrPositionKey: positionKey!, reviewedById: req.agent!.id },
        });
      } else {
        await tx.jobApplication.updateMany({
          where: { id: { in: okIds } },
          // Новый этап - не HIRED, значит дата выхода (если стояла) больше не правда.
          data: { status: status!, hiredAt: null, reviewedById: req.agent!.id },
        });
        // Ушли со стадии собеседования - ждущие звонки робота гаснут (как в PATCH).
        await tx.interviewInviteCall.updateMany({
          where: { jobApplicationId: { in: okIds }, status: { in: ["PENDING", "NO_ANSWER"] } },
          data: { status: "CANCELLED" },
        });
      }
    }
    return { ok, skipped };
  });

  for (const row of result.ok) {
    if (action === "setStatus") {
      if (row.status !== status) logAudit(req, "VACANCY_STATUS", "JobApplication", row.id, { from: row.status, to: status!, bulk: true });
    } else {
      logAudit(req, "VACANCY_UPDATE", "JobApplication", row.id, { fields: ["hrPositionKey"], positionKey: positionKey!, bulk: true });
    }
  }
  res.json({ updated: result.ok.length, skipped: result.skipped });
});
