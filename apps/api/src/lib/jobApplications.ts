/**
 * Анкеты кандидатов, собранные ботом, — накопление и очередь для руководства.
 *
 * Одна анкета на диалог (upsert по conversationId): кандидат отвечает по одному
 * вопросу за ход, и запись пополняется, а не плодится копиями. Новое значение поля
 * ПЕРЕКРЫВАЕТ старое только когда оно есть: модель, не увидевшая возраста в этом
 * ходе, не должна стирать возраст, названный в прошлом.
 *
 * С 21.09.2026 анкета знает ещё и ЧЕЛОВЕКА (`contactProfileId`), а не только
 * разговор. Разговор у одного кандидата может быть не один: написал в Instagram,
 * получил ответ, продолжил в WhatsApp — и до этой привязки заводилась вторая
 * анкета, а бот спрашивал возраст и опыт заново. Досье есть у каждого написавшего
 * с первого сообщения, поэтому привязка ведётся прежде всего к нему, а `clientId`
 * (он появляется только у оформленного лида) идёт следом, когда карточка есть.
 *
 * Тем же ходом поля анкеты зеркалятся в досье (`facts.job`) — оттуда их читает
 * промт бота во ВСЕХ каналах, в том числе в том, где этого разговора не было.
 */

import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { jobEligibility, jobPriority, jobPriorityReason, type JobApplicationDraft } from "../ai/jobApplication.js";
import type { StoredAttachment } from "../ai/shared.js";
import { recordContactFacts } from "./contactProfiles.js";
import { WHATSAPP_CHANNEL, whatsAppPhoneFromSubscriberId, findClientByPhoneDigits } from "./whatsappPhone.js";
import { detachAgentForCandidate, notifyCandidateOwners } from "./clientToCandidate.js";
import { trashBlocker } from "./trashClient.js";
import { isPlaceholderName } from "./placeholderName.js";

/**
 * Досье и карточка по разговору. `JobApplication.conversationId` — это id из ОДНОЙ
 * из трёх таблиц переписки (мессенджеры, Telegram-бот, Telegram-директ), связи в
 * схеме у него нет, поэтому спрашиваем по очереди. Нашли — дальше не ищем.
 */
async function conversationLinks(
  conversationId: string
): Promise<{ contactProfileId: string | null; clientId: string | null }> {
  const select = { contactProfileId: true, clientId: true } as const;
  const bot = await prisma.botConversation.findUnique({ where: { id: conversationId }, select });
  if (bot) return bot;
  const tg = await prisma.telegramConversation.findUnique({ where: { id: conversationId }, select });
  if (tg) return tg;
  const tgd = await prisma.telegramDirectConversation.findUnique({ where: { id: conversationId }, select });
  return tgd ?? { contactProfileId: null, clientId: null };
}

/**
 * ЧТО ЧЕЛОВЕК УЖЕ РАССКАЗАЛ В ДРУГИХ РАЗГОВОРАХ — затравка для НОВОЙ анкеты
 * (02.10.2026). Кандидат начал в Instagram, продолжил в WhatsApp: вторая анкета
 * раньше начиналась пустой, и руководство видело «половинку» без возраста и
 * опыта, а допуск и цвет считались заново с нуля. Свежая непустая запись поля
 * перекрывает старую — то же правило, что у jobApplicationKnownFacts ниже, но с
 * самими значениями (номер, резюме, да/нет по продажам), а не с фактами для промта.
 */
const SEED_FIELDS = {
  name: true,
  age: true,
  city: true,
  experience: true,
  education: true,
  hasCar: true,
  languages: true,
  startWhen: true,
  studyingNow: true,
  studyingUniversity: true,
  employedNow: true,
  salesExperience: true,
  targetEducation: true,
  phone: true,
  cvFile: true,
} as const;

async function seedFromOtherApplications(
  contactProfileId: string,
  conversationId: string
): Promise<Record<string, string | number | boolean>> {
  const rows = await prisma.jobApplication.findMany({
    where: { contactProfileId, NOT: { conversationId } },
    orderBy: { updatedAt: "asc" },
    take: 20,
    select: SEED_FIELDS,
  });
  const out: Record<string, string | number | boolean> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined || value === "") continue;
      out[key] = value as string | number | boolean;
    }
  }
  return out;
}

/**
 * НОМЕР, КОТОРЫЙ НАМ И ТАК ИЗВЕСТЕН ОТ КАНАЛА (жалоба HR 25.09.2026: «не вижу
 * номера этих людей»).
 *
 * До этой правки номер попадал в анкету только когда кандидат сам его напечатал.
 * У пишущего в WhatsApp номер — это и есть адрес переписки (wa_id), но анкета
 * оставалась «без номера»: HR его не видел, экран прятал такую анкету из
 * «Подходят», а догоняющая просьба (lib/askCandidatePhone.ts) спрашивала номер
 * у человека, с чьего номера мы и переписываемся. Берём его из самого канала —
 * то же приведение, что у лида (whatsAppPhoneFromSubscriberId). Остальные каналы
 * номера не дают, для них null.
 */
export async function channelPhoneForConversation(conversationId: string, channel: string): Promise<string | null> {
  if (channel !== WHATSAPP_CHANNEL) return null;
  const conv = await prisma.botConversation.findUnique({
    where: { id: conversationId },
    select: { channel: true, subscriberId: true },
  });
  if (!conv) return null;
  return whatsAppPhoneFromSubscriberId(conv.channel, conv.subscriberId);
}

export async function recordJobApplication(input: {
  conversationId: string;
  channel: string;
  contactName?: string | null;
  /** Досье написавшего. Пусто — анкета всё равно пишется, просто без памяти о человеке. */
  contactProfileId?: string | null;
  /**
   * Карточка клиента, если она у человека есть. Не передана (undefined) — берётся из
   * разговора или досье. `null` — НЕ привязывать вовсе: найденная карточка может
   * оказаться чужой (номер родственника) или не снятой с продаж (см. captureCandidate).
   */
  clientId?: string | null;
  draft: JobApplicationDraft;
  /** Вложения ЭТОГО хода, уже сохранённые в закрытое хранилище (messengers/attachments.ts
   *  storeFetchedAttachments) — резюме приходит документом или фото, отдельного приёма
   *  CV нет, это тот же общий путь, что у фото/голосовых в переписке. */
  attachments?: StoredAttachment[];
  // true — анкета записана; false — запись не удалась (сбой уже в журнале). Вызывающие,
  // которым всё равно, результат игнорируют, как и раньше; приём кандидата (captureCandidate)
  // и добор (backfillJobApplications) по нему решают, можно ли двигаться дальше (HELPER-FINAL02).
}): Promise<boolean> {
  try {
    const d = input.draft;
    // Резюме — последний присланный за разговор файл/фото. Кандидат может прислать
    // документ не с первого раза (не тот файл, испортил и переслал заново) — берём
    // самый свежий, а не первый: старую версию найдёт руководство в самой переписке.
    const cv = (input.attachments ?? []).filter((a) => a.kind === "file" || a.kind === "image").pop();
    // summary копится хвостом, а не перезаписывается: каждая реплика кандидата —
    // часть рассказа, и руководству нужен весь рассказ, а не последняя фраза.
    const stored = await prisma.jobApplication.findUnique({
      where: { conversationId: input.conversationId },
      select: {
        rawText: true,
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
        phone: true,
      },
    });
    // Привязка к человеку и карточке — см. комментарий у upsert ниже. Ищется до
    // расчёта: новая анкета берёт затравку из других разговоров того же человека.
    const links =
      input.contactProfileId !== undefined && input.clientId !== undefined
        ? null
        : await conversationLinks(input.conversationId);
    const contactProfileId = input.contactProfileId ?? links?.contactProfileId ?? null;
    const seed = !stored && contactProfileId ? await seedFromOtherApplications(contactProfileId, input.conversationId) : {};
    // Для расчёта ниже затравка ведёт себя как уже записанная анкета: допуск и цвет
    // второй анкеты считаются по всему, что человек уже рассказал.
    const existing = (stored ?? (Object.keys(seed).length > 0 ? seed : null)) as typeof stored;
    // Номер из канала — только когда ни анкета, ни этот ход номера не дали:
    // напечатанный кандидатом номер (другой, «звоните на этот») главнее.
    const channelPhone =
      d.phone === undefined && !existing?.phone
        ? await channelPhoneForConversation(input.conversationId, input.channel)
        : null;
    // ХВОСТ, а не голова (02.10.2026): рассказ копится по ходу разговора, и при
    // переполнении терять надо самое старое, а не то, что кандидат сказал сейчас.
    const rawText = [existing?.rawText, d.summary].filter(Boolean).join("\n").slice(-8000) || null;

    /**
     * Допуск считается по НАКОПЛЕННОЙ анкете, а не по одному ходу.
     *
     * Возраст кандидат называет в одном сообщении, про учёбу отвечает в другом, и
     * ход, в котором пришло только одно из двух, ничего не знает про второе. Считать
     * по нему значило бы то допускать, то отклонять одного и того же человека от
     * реплики к реплике. Поэтому берём то, что уже записано, и перекрываем тем, что
     * пришло сейчас (см. jobEligibility в ai/jobApplication.ts).
     */
    const eligible = jobEligibility({
      age: d.age ?? existing?.age ?? null,
      studyingUniversity: d.studyingUniversity ?? existing?.studyingUniversity ?? null,
      studyingNow: d.studyingNow ?? existing?.studyingNow ?? null,
      employedNow: d.employedNow ?? existing?.employedNow ?? null,
    });

    /**
     * ЦВЕТ ПЕРЕСЧИТЫВАЕТСЯ ПОЛНОСТЬЮ ПРИ КАЖДОЙ ЗАПИСИ, ПО НАКОПЛЕННОЙ АНКЕТЕ
     * (владелец 03.09.2026, ужесточено 25.09.2026 — см. шапку jobPriority в
     * ai/jobApplication.ts). Модель больше не присылает свой цвет: сравнивать
     * «что было» с «что вышло сейчас» через strongerPriority незачем — jobPriority
     * сам знает и явные булевы поля (salesExperience/targetEducation), и слова в
     * experience/education, и просто ПЕРЕЗАПИСЫВАЕТ цвет заново, целиком по
     * накопленной анкете, а не поверх старого значения.
     */
    const experience = d.experience ?? existing?.experience ?? null;
    const education = d.education ?? existing?.education ?? null;
    const salesExperience = d.salesExperience ?? existing?.salesExperience ?? null;
    const targetEducation = d.targetEducation ?? existing?.targetEducation ?? null;
    const hasCar = d.hasCar ?? existing?.hasCar ?? null;
    const strongMotivation = d.strongMotivation ?? existing?.strongMotivation ?? null;
    const priorityInput = { experience, education, salesExperience, targetEducation, hasCar, strongMotivation };
    const priority = jobPriority(priorityInput);
    const priorityReason = jobPriorityReason({ priority, ...priorityInput });

    const patch = {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.age !== undefined ? { age: d.age } : {}),
      ...(d.studyingUniversity !== undefined ? { studyingUniversity: d.studyingUniversity } : {}),
      ...(d.studyingNow !== undefined ? { studyingNow: d.studyingNow } : {}),
      ...(d.employedNow !== undefined ? { employedNow: d.employedNow } : {}),
      ...(d.city !== undefined ? { city: d.city } : {}),
      ...(d.education !== undefined ? { education: d.education } : {}),
      ...(d.salesExperience !== undefined ? { salesExperience: d.salesExperience } : {}),
      ...(d.targetEducation !== undefined ? { targetEducation: d.targetEducation } : {}),
      // priority/priorityReason — всегда ПАРОЙ и всегда результат кода (см. выше),
      // никогда не только один из них: разъехавшиеся цвет и причина хуже, чем оба
      // отсутствующих.
      ...(priority !== null ? { priority, priorityReason } : {}),
      ...(eligible !== null ? { eligible } : {}),
      ...(d.experience !== undefined ? { experience: d.experience } : {}),
      ...(d.hasCar !== undefined ? { hasCar: d.hasCar } : {}),
      ...(d.strongMotivation !== undefined ? { strongMotivation: d.strongMotivation } : {}),
      ...(d.achievements !== undefined ? { achievements: d.achievements } : {}),
      ...(d.languages !== undefined ? { languages: d.languages } : {}),
      ...(d.startWhen !== undefined ? { startWhen: d.startWhen } : {}),
      ...(d.phone !== undefined ? { phone: d.phone } : channelPhone ? { phone: channelPhone } : {}),
      ...(rawText !== null ? { rawText } : {}),
      ...(cv?.file ? { cvFile: cv.file } : {}),
    };

    // Привязка к человеку проставляется и при создании, и при обновлении: у анкет,
    // собранных до 21.09.2026, её нет вовсе, и первый же новый ход её дописывает.
    //
    // Профиль ищется сам, если вызывающий его не передал. Это нарочно: вызовов
    // recordJobApplication пять (два канала, обратная засыпка, перевод клиента в
    // кандидаты), и забытый аргумент в одном из них тихо отключил бы память бота
    // ровно в том канале — это самый частый класс поломок в этом проекте.
    //
    // КАРТОЧКА (clientId) — тем же ходом (02.10.2026). Поле в схеме было, но его
    // не заполнял никто: экран руководства не мог свести анкету с карточкой того
    // же человека. Берём явно переданную, иначе карточку разговора, иначе досье.
    const noLink = input.clientId === null;
    let clientId = noLink ? null : (input.clientId ?? links?.clientId ?? null);
    if (!clientId && !noLink && contactProfileId) {
      clientId =
        (await prisma.contactProfile.findUnique({ where: { id: contactProfileId }, select: { clientId: true } }))
          ?.clientId ?? null;
    }
    const link = {
      ...(contactProfileId ? { contactProfileId } : {}),
      ...(clientId ? { clientId } : {}),
    };

    const saved = await prisma.jobApplication.upsert({
      where: { conversationId: input.conversationId },
      create: {
        conversationId: input.conversationId,
        channel: input.channel,
        contactName: input.contactName ?? null,
        ...link,
        ...seed,
        ...patch,
      },
      update: { ...link, ...patch },
      select: JOB_FACT_FIELDS,
    });

    // Зеркало в досье — тем же ходом, что и сама анкета, иначе память о человеке и
    // анкета разъезжаются. Зеркалится НАКОПЛЕННАЯ запись, а не черновик этого хода:
    // в ходе приходит одно поле, а промту нужно всё, что кандидат успел рассказать.
    if (contactProfileId) {
      await recordContactFacts({
        profileId: contactProfileId,
        domain: "job",
        values: jobFactsFromApplication(saved),
        source: "model",
        conversationId: input.conversationId,
      });
    }
    return true;
  } catch (err) {
    // Разговор с кандидатом это ронять не должно.
    void logSystemError("ai", `Анкета кандидата не записана: ${describeError(err)}`);
    return false;
  }
}

/**
 * Поля анкеты, которые попадают в досье и в свод «что он уже рассказал».
 *
 * Сюда намеренно НЕ входят `rawText` (весь рассказ — это страница текста, промту
 * столько не нужно), `priority`/`priorityReason`/`eligible` (внутренние пометки
 * отбора, кандидату их знать нельзя, а бот читает досье вслух) и `phone` — номер
 * живёт идентичностью досье, а не фактом; в фактах от него остаётся только
 * признак «номер уже дал», чтобы бот не просил его второй раз.
 */
const JOB_FACT_FIELDS = {
  name: true,
  age: true,
  city: true,
  experience: true,
  education: true,
  hasCar: true,
  strongMotivation: true,
  achievements: true,
  languages: true,
  startWhen: true,
  studyingNow: true,
  studyingUniversity: true,
  employedNow: true,
  phone: true,
  cvFile: true,
} as const;

export type JobApplicationFacts = {
  [K in keyof typeof JOB_FACT_FIELDS]: unknown;
};

/** Запись анкеты → плоские факты досье. Пустые поля отбрасывает `recordContactFacts`. */
export function jobFactsFromApplication(
  app: Partial<Record<keyof typeof JOB_FACT_FIELDS, unknown>>
): Record<string, string | number | boolean | null | undefined> {
  const value = (key: keyof typeof JOB_FACT_FIELDS) => {
    const v = app[key];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
  };
  return {
    name: value("name"),
    age: value("age"),
    city: value("city"),
    experience: value("experience"),
    education: value("education"),
    hasCar: value("hasCar"),
    strongMotivation: value("strongMotivation"),
    achievements: value("achievements"),
    languages: value("languages"),
    startWhen: value("startWhen"),
    studyingNow: value("studyingNow"),
    studyingUniversity: value("studyingUniversity"),
    employedNow: value("employedNow"),
    // Не сам номер, а признак: бот читает досье вслух, и номер в промте — лишняя
    // копия личных данных там, где хватает «номер уже дал».
    phoneGiven: app.phone ? true : null,
    cvSent: app.cvFile ? true : null,
  };
}

/**
 * ЧТО ЭТОТ ЧЕЛОВЕК УЖЕ РАССКАЗАЛ — по ВСЕМ его анкетам, а не по текущему разговору.
 *
 * Кандидат мог начать в Instagram, а продолжить в WhatsApp: это два разговора и две
 * записи, но один человек. Свежая непустая запись поля перекрывает старую — человек
 * взрослеет, переезжает и меняет работу, и последнее сказанное вернее первого.
 *
 * Нужна экрану руководства (одна карточка вместо двух половинок) и обратной засыпке
 * досье. Промт бота читает те же поля из досье (`facts.job`), а не отсюда: там они
 * лежат вместе с происхождением и не требуют запроса в базу на каждый ход.
 */
export async function jobApplicationKnownFacts(
  contactProfileId: string
): Promise<Record<string, string | number | boolean | null | undefined>> {
  const rows = await prisma.jobApplication.findMany({
    where: { contactProfileId },
    orderBy: { updatedAt: "asc" },
    // Потолок выборки: у человека их единицы, сотня — уже признак поломки, и
    // читать её всю незачем.
    take: 100,
    select: JOB_FACT_FIELDS,
  });
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(jobFactsFromApplication(row))) {
      if (value === null || value === undefined || value === "") continue;
      out[key] = value;
    }
  }
  return out;
}

/**
 * РАССКАЗ КАНДИДАТА О СЕБЕ УЖЕ СОБРАН?
 *
 * По SCENARIO_JOB «передам руководству» — это ШАГ 3, и он законен только после
 * резюме или рассказа. Раньше приём выдавал эту фразу на ЛЮБОЙ номер, и разговор
 * обрывался на человеке, о котором не известно ничего (владелец 17.09.2026:
 * «ИИ не спрашивает информацию, тупо берёт номер»).
 *
 * Смотрим на разобранные поля, а НЕ на rawText: rawText анкета копит из слов
 * клиента за весь разговор и он непуст уже после «Салом, кор ҳаст?». Поля
 * `experience`/`education`/`age` заполняются только из настоящего рассказа, а
 * `cvFile` — из присланного резюме.
 */
export async function candidateStoryCollected(conversationId: string): Promise<boolean> {
  const app = await prisma.jobApplication.findUnique({
    where: { conversationId },
    select: { cvFile: true, experience: true, education: true, age: true },
  });
  if (!app) return false;
  return !!app.cvFile || !!app.experience?.trim() || !!app.education?.trim() || app.age != null;
}

/**
 * КАНДИДАТ НИКОГДА НЕ ОСТАЁТСЯ У АГЕНТА ПО ПРОДАЖАМ — ОДНО МЕСТО НА ВСЕ КАНАЛЫ
 * (02.10.2026, разбор приёма кандидатов в каналах).
 *
 * Правило владельца уже было сделано в Telegram-боте, но в остальных каналах
 * держалось наполовину:
 *  · WhatsApp/Instagram/Facebook/сайт искали «старую карточку» только через
 *    `botConversation.clientId`, а приём номера зовётся ровно тогда, когда он
 *    пуст, — снятие агента не срабатывало никогда; карточку по названному
 *    номеру не искал никто;
 *  · Telegram Direct Messages кандидатов не знал вовсе: «агент свяжется»;
 *  · каждый следующий номер в том же разговоре снова слал руководству
 *    «💼 Новый кандидат» — одно событие, много уведомлений.
 *
 * Здесь три шага, общие для всех каналов: найти карточку человека (карточка
 * разговора → названный номер → чат Telegram), снять с неё агента, если она ещё
 * в продажах, и позвать руководство — ОДИН раз на разговор.
 */

/** В какой таблице переписки живёт разговор — от этого зависит, где ставить отметку. */
export type CandidateConversationTable = "bot" | "telegram" | "telegramDirect";

/**
 * ОДНО УВЕДОМЛЕНИЕ НА РАЗГОВОР — атомарный захват отметки в черновике разговора
 * (`leadDraft.candidateNoticeAt`). UPDATE с условием «отметки ещё нет» — тот же
 * приём, что захват хода приёма заявки в messengers/conversation.ts: из двух
 * одновременных ходов отметку ставит ровно один. Черновик переживает ходы
 * квалификатора (mergeDraft переносит незнакомые поля как есть), поэтому
 * отметка не слетает со следующим сообщением.
 *
 * true — этот вызов первый, уведомлять можно.
 */
export async function claimCandidateNotice(table: CandidateConversationTable, conversationId: string): Promise<boolean> {
  const stamp = new Date().toISOString();
  let claimed: number;
  if (table === "bot") {
    claimed = await prisma.$executeRaw`
      UPDATE "BotConversation"
      SET "leadDraft" = jsonb_set(COALESCE("leadDraft", '{}'::jsonb), '{candidateNoticeAt}', to_jsonb(${stamp}::text))
      WHERE "id" = ${conversationId} AND NOT (COALESCE("leadDraft", '{}'::jsonb) ? 'candidateNoticeAt')`;
  } else if (table === "telegram") {
    claimed = await prisma.$executeRaw`
      UPDATE "TelegramConversation"
      SET "leadDraft" = jsonb_set(COALESCE("leadDraft", '{}'::jsonb), '{candidateNoticeAt}', to_jsonb(${stamp}::text))
      WHERE "id" = ${conversationId} AND NOT (COALESCE("leadDraft", '{}'::jsonb) ? 'candidateNoticeAt')`;
  } else {
    claimed = await prisma.$executeRaw`
      UPDATE "TelegramDirectConversation"
      SET "leadDraft" = jsonb_set(COALESCE("leadDraft", '{}'::jsonb), '{candidateNoticeAt}', to_jsonb(${stamp}::text))
      WHERE "id" = ${conversationId} AND NOT (COALESCE("leadDraft", '{}'::jsonb) ? 'candidateNoticeAt')`;
  }
  return claimed > 0;
}

/**
 * Снимает захват уведомления (`leadDraft.candidateNoticeAt`) — когда после захвата
 * приём не состоялся (анкета не записалась), и следующий ход должен повторить его как
 * первый, с рассказом целиком и уведомлением руководству (HELPER-FINAL02).
 */
export async function releaseCandidateNotice(table: CandidateConversationTable, conversationId: string): Promise<void> {
  if (table === "bot") {
    await prisma.$executeRaw`
      UPDATE "BotConversation" SET "leadDraft" = "leadDraft" - 'candidateNoticeAt'
      WHERE "id" = ${conversationId} AND jsonb_typeof("leadDraft") = 'object'`;
  } else if (table === "telegram") {
    await prisma.$executeRaw`
      UPDATE "TelegramConversation" SET "leadDraft" = "leadDraft" - 'candidateNoticeAt'
      WHERE "id" = ${conversationId} AND jsonb_typeof("leadDraft") = 'object'`;
  } else {
    await prisma.$executeRaw`
      UPDATE "TelegramDirectConversation" SET "leadDraft" = "leadDraft" - 'candidateNoticeAt'
      WHERE "id" = ${conversationId} AND jsonb_typeof("leadDraft") = 'object'`;
  }
}
/**
 * Живая (не из Корзины) карточка этого человека: карточка разговора, затем по
 * адресу канала (номер WhatsApp, чат Telegram — это сам человек), затем по
 * НАПЕЧАТАННОМУ номеру (то же терпимое к записи сравнение, что у приёма заявки).
 * null — карточки нет, и заводить её не надо: кандидат живёт анкетой.
 *
 * `byTypedPhone` — карточка нашлась ТОЛЬКО по напечатанному номеру. Такой номер
 * может быть чужим («звоните брату»), и снимать по нему карточку с агента
 * без оглядки нельзя (см. captureCandidate).
 */
export async function findCandidateCard(input: {
  clientId?: string | null;
  /** Номера, которые и есть адрес человека в канале (wa_id). */
  identityPhones?: Array<string | null | undefined>;
  /** Номера, которые человек напечатал сам. */
  typedPhones?: Array<string | null | undefined>;
  telegramChatId?: string | null;
}): Promise<{ id: string; byTypedPhone: boolean } | null> {
  if (input.clientId) {
    const own = await prisma.client.findUnique({ where: { id: input.clientId }, select: { deletedAt: true } });
    if (own && !own.deletedAt) return { id: input.clientId, byTypedPhone: false };
  }
  for (const phone of input.identityPhones ?? []) {
    if (!phone) continue;
    const match = await findClientByPhoneDigits(phone);
    if (match && !match.deletedAt) return { id: match.id, byTypedPhone: false };
  }
  if (input.telegramChatId) {
    const byChat = await prisma.client.findFirst({
      where: { telegramChatId: input.telegramChatId, deletedAt: null },
      select: { id: true },
    });
    if (byChat) return { id: byChat.id, byTypedPhone: false };
  }
  for (const phone of input.typedPhones ?? []) {
    if (!phone) continue;
    const match = await findClientByPhoneDigits(phone);
    if (match && !match.deletedAt) return { id: match.id, byTypedPhone: true };
  }
  return null;
}

/**
 * МОЖНО ЛИ СНЯТЬ КАРТОЧКУ С ПРОДАЖ АВТОМАТИЧЕСКИ (разбор ветки 02.10.2026).
 *
 * Модель путает намерение, а номер, напечатанный кандидатом, бывает чужим. Без
 * этой проверки снимались бы с агента:
 *  · продавец с объектами в работе, спросивший «у вас есть вакансии для брата?»;
 *  · покупатель, чей номер кандидат дал как номер родственника.
 *
 * Поэтому: (1) карточку со сделкой или объектами в работе автоматика не трогает
 * никогда — тот же запрет, что у удаления (lib/trashClient.ts::trashBlocker);
 * (2) карточку, найденную только по напечатанному номеру, снимаем, лишь если
 * агента у неё нет — у агента её забирает только человек.
 *
 * Возвращает:
 *  · "detach" — снимать;
 *  · "already" — уже не в продажах, трогать нечего, но это карточка человека;
 *  · "keep" — не трогать и анкету к ней не привязывать.
 */
async function candidateCardDecision(card: { id: string; byTypedPhone: boolean }): Promise<"detach" | "already" | "keep"> {
  const row = await prisma.client.findUnique({
    where: { id: card.id },
    select: { assignedAgentId: true, kind: true },
  });
  if (!row) return "keep";
  if (!row.assignedAgentId && row.kind === "OTHER") return "already";
  if (await trashBlocker(card.id)) return "keep";
  if (card.byTypedPhone && row.assignedAgentId) return "keep";
  return "detach";
}

/**
 * Принять кандидата: найти его карточку, снять с неё агента, записать анкету и
 * позвать руководство один раз за разговор. Карточку НЕ заводит.
 *
 * `application` — пусто, когда анкету уже пишет вызывающий (ход квалификатора с
 * полем модели); тогда здесь только карточка и уведомление.
 *
 * Не бросает: разговор с кандидатом не должен падать из-за этой обвязки.
 */
export async function captureCandidate(input: {
  table: CandidateConversationTable;
  conversationId: string;
  /** Канал анкеты: WHATSAPP / INSTAGRAM / TELEGRAM / TELEGRAM_DIRECT… */
  channel: string;
  /** Имя для уведомления руководству. Заглушки («Клиент Telegram») отбрасываются. */
  name?: string | null;
  /** Карточка разговора, если она уже есть. */
  knownClientId?: string | null;
  /** Номера-адреса человека в канале (wa_id): по ним карточка — точно его. */
  identityPhones?: Array<string | null | undefined>;
  /** Номера, которые человек напечатал: могут быть чужими. */
  typedPhones?: Array<string | null | undefined>;
  telegramChatId?: string | null;
  application?: {
    contactName?: string | null;
    contactProfileId?: string | null;
    phone: string;
    /** Имя, которое кандидат назвал сам или которое похоже на настоящее. */
    name?: string;
    /** Все слова кандидата за разговор — в анкету идут только на первом приёме. */
    wholeStory: string;
    /** Слова этого хода — на повторных приёмах, чтобы рассказ не дублировался. */
    newText: string;
    attachments?: StoredAttachment[];
  };
}): Promise<{ clientId: string | null; detached: boolean; notified: boolean }> {
  // Канал анкеты Telegram-директа — "TELEGRAM_DIRECT" (так его ищет раздел
  // «Вакансии»), а для слов в уведомлении и хронологии есть общий код канала
  // переписки "TELEGRAM_DM" («личка Telegram», @royal-home/shared): иначе в
  // пуше руководству стоял бы сырой код.
  const wordsChannel = input.channel === "TELEGRAM_DIRECT" ? "TELEGRAM_DM" : input.channel;
  // Заглушку вместо имени («Клиент Telegram», «Клиент Instagram», ник) в анкету и
  // в уведомление не пишем — тот же фильтр, что у ручного перевода в кандидаты.
  const realName = (n: string | null | undefined) => (n && !isPlaceholderName(n) ? n.trim() : undefined);
  try {
    const app = input.application;
    /**
     * ОДНО УВЕДОМЛЕНИЕ НА РАЗГОВОР — ДВА СЛОЯ (02.10.2026, доразбор).
     *
     * 1) Отметка в анкете, которая не стирается ничьим ходом: если номер, который
     *    человек напечатал, уже лежит в анкете этого разговора, приём уже был и
     *    руководство уже звали. Номер WhatsApp (адрес канала) анкета получает
     *    сама, без приёма, поэтому он отметкой не считается.
     * 2) Атомарный захват `leadDraft.candidateNoticeAt` — разводит два
     *    одновременных приёма. Сам по себе он не надёжен: параллельный ход
     *    квалификатора может записать устаревший черновик поверх и стереть его.
     *
     * Почему не «анкета создана этим вызовом»: анкета обычно появляется раньше
     * номера — модель заполняет её, пока кандидат рассказывает о себе, — и тогда
     * руководство не позвали бы никогда.
     */
    let alreadyCaptured = false;
    if (app) {
      const before = await prisma.jobApplication.findUnique({
        where: { conversationId: input.conversationId },
        select: { phone: true },
      });
      const channelPhone = await channelPhoneForConversation(input.conversationId, input.channel);
      alreadyCaptured = !!before?.phone && before.phone !== channelPhone;
    }
    const firstNotice = !alreadyCaptured && (await claimCandidateNotice(input.table, input.conversationId));

    const card = await findCandidateCard({
      clientId: input.knownClientId,
      identityPhones: input.identityPhones,
      typedPhones: input.typedPhones,
      telegramChatId: input.telegramChatId,
    });
    const decision = card ? await candidateCardDecision(card) : null;
    // Анкету привязываем только к карточке, которая точно этого человека и не
    // осталась в продажах: «keep» — чужой номер или сделка, связь была бы враньём.
    const clientId = card && decision !== "keep" ? card.id : null;

    if (app) {
      // На первом приёме — весь рассказ (до номера кандидат мог рассказать о себе
      // несколько сообщений подряд), дальше — только новые слова: раньше каждый
      // следующий номер дописывал в анкету весь разговор заново.
      const summary = (firstNotice ? app.wholeStory : app.newText).trim().slice(0, 2000);
      const name = realName(app.name);
      const recorded = await recordJobApplication({
        conversationId: input.conversationId,
        channel: input.channel,
        contactName: app.contactName ?? null,
        ...(app.contactProfileId !== undefined ? { contactProfileId: app.contactProfileId } : {}),
        clientId: clientId ?? (card ? null : undefined),
        draft: {
          phone: app.phone,
          ...(name ? { name } : {}),
          ...(summary ? { summary } : {}),
        },
        attachments: app.attachments,
      });
      if (!recorded) {
        // Анкета не записалась (временный сбой): карточку с агента не снимаем и руководство
        // не зовём, иначе приём выглядел бы состоявшимся, а анкеты нет, и следующий ход
        // сохранил бы только свои слова (HELPER-FINAL02). Захват снимаем, чтобы повтор
        // был снова «первым приёмом» с рассказом целиком.
        if (firstNotice) await releaseCandidateNotice(input.table, input.conversationId);
        return { clientId, detached: false, notified: false };
      }
    }

    let detached = false;
    if (card && decision === "detach") {
      const result = await detachAgentForCandidate({
        clientId: card.id,
        actorId: null,
        reason: "человек написал по вакансии, карточка снята с агента",
        channel: wordsChannel,
      });
      detached = result.ok;
    }

    // Без анкеты (ход квалификатора у уже привязанной карточки) зовём руководство
    // только когда карточку действительно сняли с продаж: этот ход потом сам
    // перезаписывает черновик разговора, и отметка `candidateNoticeAt` могла бы не
    // дожить до следующего хода. Снятие же случается ровно один раз — карточка
    // после него уже не в продажах, и повторного уведомления не будет.
    const notify = firstNotice && (app ? true : detached);
    if (notify) {
      void notifyCandidateOwners({
        name: realName(input.name),
        channel: wordsChannel,
        conversationId: input.conversationId,
        why: detached ? "обращение переведено из клиентов" : "оставил номер в переписке",
      });
    }
    return { clientId, detached, notified: notify };
  } catch (err) {
    void logSystemError("ai", `Кандидат (${input.channel}, диалог ${input.conversationId}) не принят: ${describeError(err)}`);
    return { clientId: null, detached: false, notified: false };
  }
}

/**
 * КАНДИДАТ ПО ВХОДЯЩЕМУ ЗВОНКУ (Dan 02.10.2026: «если человек звонит в офис насчёт
 * работы, он сам попадает в «Вакансии» и снимается с агента»).
 *
 * Те же шаги и те же части, что у captureCandidate: карточку ищет findCandidateCard
 * (номер звонившего — его адрес, как wa_id в WhatsApp), «снимать ли» решает
 * candidateCardDecision (сделку и объекты в работе не трогаем никогда), снимает
 * detachAgentForCandidate, зовёт руководство notifyCandidateOwners.
 *
 * ОТЛИЧИЕ ОДНО — У ЗВОНКА НЕТ ПЕРЕПИСКИ. Анкета держится не диалогом
 * (`conversationId` пуст: экран «Вакансии» тогда честно не показывает кнопку
 * «Переписка»), а НОМЕРОМ: позвонил второй раз — дополняется та же анкета; уже
 * писал в WhatsApp и оставил этот номер — дополняется анкета из переписки, а не
 * заводится вторая. Руководство зовём, только когда анкета заведена этим звонком
 * или карточку действительно сняли с агента: повторный звонок того же кандидата
 * второго «Новый кандидат» не шлёт.
 *
 * Карточку НЕ заводит. Не бросает: это фоновая работа после разговора
 * (lib/telephony/autoLeadFromCall.ts).
 */
export const PHONE_CALL_CHANNEL = "PHONE_CALL";

export async function captureCandidateFromCall(input: {
  /** Номер звонившего, как его записала станция. */
  phone: string;
  /** Карточка, к которой станция уже привязала звонок. */
  knownClientId?: string | null;
  /** Имя, если человек назвался в разговоре. */
  name?: string | null;
  /** Что он сказал — пересказ разбора или сама расшифровка. */
  summary?: string | null;
}): Promise<{ applicationId: string | null; clientId: string | null; detached: boolean; notified: boolean }> {
  try {
    const card = await findCandidateCard({ clientId: input.knownClientId, identityPhones: [input.phone] });
    const decision = card ? await candidateCardDecision(card) : null;
    // «keep» — сделка или объекты в работе: карточку не трогаем и анкету к ней не
    // привязываем (та же оговорка, что у captureCandidate).
    const clientId = card && decision !== "keep" ? card.id : null;

    const name = input.name && !isPlaceholderName(input.name) ? input.name.trim() : null;
    const said = (input.summary ?? "").trim().slice(0, 2000);
    const entry = `Звонок в офис ${new Date().toISOString().slice(0, 10)}${said ? `: ${said}` : ""}`;

    const existing = await prisma.jobApplication.findFirst({
      where: { phone: input.phone, NOT: { status: "NOT_CANDIDATE" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, rawText: true, clientId: true },
    });
    const application = existing
      ? await prisma.jobApplication.update({
          where: { id: existing.id },
          data: {
            // Хвост, а не голова — то же правило, что у recordJobApplication.
            rawText: [existing.rawText, entry].filter(Boolean).join("\n").slice(-8000),
            ...(name && !existing.name ? { name } : {}),
            ...(clientId && !existing.clientId ? { clientId } : {}),
          },
          select: { id: true },
        })
      : await prisma.jobApplication.create({
          data: {
            channel: PHONE_CALL_CHANNEL,
            phone: input.phone,
            rawText: entry,
            ...(name ? { name } : {}),
            ...(clientId ? { clientId } : {}),
          },
          select: { id: true },
        });

    let detached = false;
    if (card && decision === "detach") {
      const result = await detachAgentForCandidate({
        clientId: card.id,
        actorId: null,
        reason: "человек позвонил в офис насчёт работы, карточка снята с агента",
        channel: PHONE_CALL_CHANNEL,
      });
      detached = result.ok;
    }

    const notify = !existing || detached;
    if (notify) {
      void notifyCandidateOwners({
        name,
        channel: PHONE_CALL_CHANNEL,
        conversationId: application.id,
        why: detached ? "позвонил насчёт работы, переведён из клиентов" : "позвонил в офис насчёт работы",
      });
    }
    return { applicationId: application.id, clientId, detached, notified: notify };
  } catch (err) {
    void logSystemError("telephony", `Кандидат по звонку (${input.phone}) не принят: ${describeError(err)}`);
    return { applicationId: null, clientId: null, detached: false, notified: false };
  }
}
