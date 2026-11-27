import type { ConversationMessage } from "@royal-home/shared";
import { channelLabel } from "@royal-home/shared";
import type { ChatMessage } from "../ai/client.js";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { extractAllPhones, extractVolunteeredPhone, unparsedPhoneAttempt } from "./shared/phoneText.js";
import { type LeadDraft } from "../ai/leadDraft.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { customerAgentIntake } from "../ai/customerAgentIntake.js";
import { customerRoleSignals } from "../ai/customerAgentRole.js";
import { phoneTail } from "./clientPhones.js";
import { maskClientPhone } from "./clientPhone.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";
import { createNotifications, shouldAlert } from "./notifications.js";
import { sendPushToAgents } from "../push.js";
import { resolveWhatsAppLeadIdentity, WHATSAPP_CHANNEL } from "./whatsappPhone.js";
import { CUSTOMER_LEAD_ONLY_INTAKE_JOB } from "./customerLeadOnlyCore.js";
import { lastAgentContactPromise, PROMISE_GRACE_MS } from "./agentContactPromise.js";
import { unansweredClientTurn, type UnansweredTurn } from "./unansweredChatTurn.js";
import { isOwnAgencyNumber } from "./publicAgencyContact.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { customerTurnSilenceIsIntended } from "./customerIntendedSilence.js";
import { customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { loadLeadOnlyConfig } from "./leadOnlyConfig.js";
import { leadOnlyAppliesTo } from "../ai/leadOnlyMode.js";
import { findStaffPhone } from "./staffPhoneGuard.js";
export { lastAgentContactPromise, PROMISE_GRACE_MS } from "./agentContactPromise.js";

/**
 * СТОРОЖ: НОМЕР В ПЕРЕПИСКЕ ЕСТЬ — КАРТОЧКИ НЕТ (ступень 3, 03.09.2026).
 *
 * Две ступени выше чинят ИЗВЕСТНЫЕ причины потери лида: ступень 1 — разбор номера
 * (местный набор через ноль больше не пропадает, ai/leadQualifier.ts), ступень 2 —
 * приём заявки перестал зависеть от того, разговаривает ли бот (messengers/conversation.ts:
 * пауза оператора, выключенный рубильник, отсечка «не по теме», предел ИИ).
 *
 * Эта ступень не чинит НИЧЕГО и в этом её смысл: она смотрит на ФАКТ, а не на
 * причину. Человек прислал номер, а карточки в базе нет — значит лид потерян,
 * и неважно, из-за какой ветки кода это случилось на этот раз. Так ловятся и
 * будущие причины: новая отсечка, сбой Meta, упавший приём, форма номера, о
 * которой мы ещё не думали.
 *
 * СТОРОЖ ЗАВОДИТ КАРТОЧКУ САМ (ступень 4, 03.09.2026, владелец: «не хочу каждый
 * раз делать такое руками»). Раньше он только звал человека, и это было честно
 * ровно наполовину: находка «номер есть, карточки нет» превращалась в ручную
 * работу руководства, которой тем больше, чем хуже работает приём.
 *
 * НО ВТОРОГО ПУТИ ПРИЁМА ЗДЕСЬ НЕТ — и это главное. Приём заявки не одна запись:
 * отказ по аренде и по другой стране, тип обращения (покупатель / продавец /
 * «прочее»), назначение агента, атрибуция рекламы, автопилот карточки. Своя
 * упрощённая версия всего этого в фоновом задании была бы вторым местом, где то
 * же самое можно забыть. Поэтому сторож зовёт ТУ ЖЕ функцию, что и живое
 * сообщение (acceptLead, messengers/conversation.ts), в тихом режиме: без хода
 * модели и без реплики клиенту — он написал три дня назад, отвечать ему сейчас
 * поздно и странно. Все отсечки внутри приёма продолжают действовать: аренда,
 * чужая страна, чужой город уходят в отказ, а не в карточку.
 *
 * ЧЕЛОВЕКА ЗОВЁМ ТОЛЬКО ТАМ, ГДЕ РЕШЕНИЕ ДЕЙСТВИТЕЛЬНО ЗА ЧЕЛОВЕКОМ:
 *  · номер не разобрался («00 000 10 08» — на номер похоже, но чей он, знает
 *    только тот, кто прочтёт переписку);
 *  · диалог помечен как рассылка — карточку спамеру заводить нельзя;
 *  · приём отказал сам (аренда, другая страна) или сорвался с ошибкой.
 *
 * ДЕДУП В ЛЕНТЕ УВЕДОМЛЕНИЙ — по tag: один диалог = одна строка, повторный тик
 * только поднимает счётчик той же строки. НО ЭТО НЕ ОГРАНИЧИВАЕТ ЧАСТОТУ ПУША:
 * upsertByTag схлопывает записи в ЛЕНТЕ, а enqueueDirectorAlert на каждый тик
 * заводит новую строку очереди, и flushDirectorAlertQueue шлёт push по каждой —
 * комментарий здесь раньше утверждал обратное, и это позволило нерешённому
 * диалогу слать пуш директору на каждый часовой тик (тот самый инцидент 128
 * подряд уведомлений). От повторной ОТПРАВКИ на каждый тик защищает shouldAlert
 * (notifications.ts, владелец 15.09.2026): не чаще раза в сутки на один tag.
 */

/** Насколько назад смотрим. Больше суток — чтобы поймать и то, что потерялось ночью;
 *  меньше недели — чтобы старые «мёртвые» диалоги не всплывали вечно. */
export const PHONE_WATCH_WINDOW_HOURS = 72;

/** Сколько последних реплик клиента разбираем в каждом диалоге: номер всегда рядом
 *  с концом разговора, а читать всю историю ради этого — лишняя работа. */
const LOOK_BACK_MESSAGES = 30;
/** Самая поздняя реплика со словами аренды или покупки: аренда ли это (реплики без обоих сигналов не в счёт). */
function lastSignalIsRent(texts: readonly string[]): boolean {
  for (const text of [...texts].reverse()) {
    const signals = customerRoleSignals(text);
    if (signals.rent) return true;
    if (signals.buyStrong || signals.buyWeak) return false;
  }
  return false;
}

/** Предел выборки: любой запрос, возвращающий массив, обязан иметь потолок. */
const MAX_CONVERSATIONS = 500;

/** Первый номер клиента в реплике, кроме номера самого агентства. Правило отбора — строгое, как у живого хода. */
function volunteeredClientPhone(text: string): string | null {
  const first = extractVolunteeredPhone(text);
  if (!first || !isOwnAgencyNumber(first)) return first;
  return extractAllPhones(text).find((p) => !isOwnAgencyNumber(p)) ?? null;
}

export interface PhoneWithoutLead {
  conversationId: string;
  channel: string;
  name: string | null;
  /** Разобранный номер, если он читается; иначе null и заполнен `raw`. */
  phone: string | null;
  /** Что именно прислал клиент, когда номер не разобрался («000001008»). */
  raw: string | null;
  spamFlagged: boolean;
  /** Реплика, в которой нашёлся номер: из неё приём берёт запасные номера и по ней
   *  же срабатывают отсечки «аренда»/«другая страна». */
  phoneText: string;
  /** Черновик заявки и переписка — их ждёт настоящий приём (см. tryAcceptQuietly). */
  draft: unknown;
  history: ConversationMessage[];
  /** Тема разговора у нового ядра бота (CustomerInquiry.publicState.topic); null — диалог вёл старый путь. */
  coreTopic: string | null;
  /** Запрос клиента в ядре (для анкеты кандидата, заведённой ядром). */
  inquiryId: string | null;
  /** Бот пообещал звонок агента (lastAgentContactPromise): номер — из WhatsApp, а не из текста. */
  promised?: boolean;
  /** Когда прозвучало обещание. */
  promisedAt?: Date;
  /** Номер WhatsApp (wa_id) для карточки, если номер взят из канала. */
  whatsappPhone?: string;
  /** Карточка заведена, но осталась без агента («Прочие», отказ или закрытое назначение), хотя бот обещал звонок. */
  landedInOther?: boolean;
  /** После обещания клиент, похоже, отказался от звонка — тихо не заводим, решает человек. */
  refusalUnclear?: boolean;
  /** Номер у карточки из Корзины: тихий приём её воскресил бы (и мог бы написать клиенту) — решает человек. */
  basketCard?: boolean;
  /**
   * WhatsApp: клиент написал по делу, бот не ответил (ядро держало ход, пауза, сбой), номер — сам отправитель
   * (27.11.2026, lib/unansweredChatTurn.ts). Отказ приёма здесь (аренда, другой город) — нормальный исход, не тревога.
   */
  unanswered?: boolean;
  /** Сотрудник CRM уже вёл эту переписку руками — карточка уходит ему же через дверь назначения (ревью #497, S3). */
  staffAgentId?: string;
}

/** Слова КЛИЕНТА этого диалога — без врезок разобранных файлов: текст внутри
 *  присланного PDF не является номером, который человек оставил сам (тот же
 *  приём, что в acceptLead). `after` — только реплики новее прошлой попытки сторожа;
 *  реплика без отметки времени к «новым» не относится: старый номер не воскрешаем. */
function clientTexts(messages: ConversationMessage[], after?: Date | null): string[] {
  return messages
    // `by` у реплики роли user — эхо сотрудника, писавшего с телефона компании (conversation.ts, fromStaff):
    // это наши слова, и номер в них (офис, свой мобильный) — не номер клиента (27.11.2026).
    .filter((m) => m.role === "user" && !m.by && typeof m.content === "string" && m.content)
    .filter((m) => !after || (typeof m.at === "string" && Date.parse(m.at) > after.getTime()))
    .slice(-LOOK_BACK_MESSAGES)
    .map((m) => stripUntrusted(m.content, ["document", "video", "voice"]));
}

/**
 * Диалоги, где клиент оставил номер, а карточки так и нет.
 *
 * Отбор в базе узкий (clientId пуст + свежий), разбор текста — в памяти: номер
 * лежит внутри JSON-переписки, и SQL по нему всё равно был бы полным перебором.
 */
export async function findPhonesWithoutLead(
  now: Date = new Date(),
  /** Только для разового добора (backfillPhonesWithoutLead): шире окно и без учёта прошлых попыток. */
  options: { windowHours?: number; ignoreAttempts?: boolean; promises?: boolean; unanswered?: boolean } = {}
): Promise<PhoneWithoutLead[]> {
  // Рубильник «Клиент написал в WhatsApp, бот не ответил — карточка сама» (27.11.2026): читается один раз на проход.
  // Разовый добор (ignoreAttempts) эту ветку по умолчанию НЕ включает (ревью #497, S2): только явным параметром.
  let unansweredOn = options.unanswered ?? (options.ignoreAttempts ? false : await automationSwitchOn("chatUnansweredCardEnabled"));
  // Режим «только заявки» (решение 13.11.2026): номер WhatsApp заявкой без слов клиента — только если режим так настроен.
  if (unansweredOn && leadOnlyAppliesTo(WHATSAPP_CHANNEL)) {
    const leadOnly = await loadLeadOnlyConfig();
    if (leadOnly.enabled && !leadOnly.useWhatsappNumber) unansweredOn = false;
  }
  const since = new Date(now.getTime() - (options.windowHours ?? PHONE_WATCH_WINDOW_HOURS) * 60 * 60 * 1000);
  const rows = await prisma.botConversation.findMany({
    // ОДНА попытка на одни и те же реплики (авария 17.09.2026). Раньше отбор был
    // только «карточки нет + свежий», а карточка у разговора о работе не появляется
    // никогда: диалог оставался кандидатом вечно и приём прогонялся заново каждые
    // 15 минут. Причина отказа сама не исчезнет — если приём не сработал с первого
    // раза, дальше это работа человека, а не крона.
    //
    // НО «одна попытка на диалог НАВСЕГДА» теряла вернувшегося клиента (14.11.2026):
    // разговор, который сторож уже разбирал когда-то (карточку потом удалили, или
    // тогда был отказ), больше не проверялся никогда, а новое ядро бота само карточку
    // по номеру почти не заводит — сторож у него главная дверь. Поэтому диалог снова
    // в отборе, если клиент написал ПОСЛЕ прошлой попытки, и разбираются только эти
    // новые реплики. Петли нет: приём из сторожа идёт с fromHistory и lastMessageAt
    // не двигает (tests/phone-lead-watchdog-loop.test.ts).
    where: {
      clientId: null,
      lastMessageAt: { gte: since },
      ...(options.ignoreAttempts ? {} : { OR: [
        { watchdogAttemptedAt: null },
        { watchdogAttemptedAt: { lt: prisma.botConversation.fields.lastMessageAt } },
      ] }),
    },
    select: {
      id: true,
      channel: true,
      subscriberId: true,
      name: true,
      messages: true,
      leadDraft: true,
      spamFlaggedAt: true,
      lastMessageAt: true,
      watchdogAttemptedAt: true,
      optedOutAt: true,
      customerInquiry: { select: { id: true, publicState: true } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_CONVERSATIONS,
  });

  const failedTurns = unansweredOn ? await provenFailedTurns(rows, now, options.ignoreAttempts ?? false) : new Map<string, UnansweredTurn>();
  const found: PhoneWithoutLead[] = [];
  for (const row of rows) {
    const history = (row.messages as unknown as ConversationMessage[]) ?? [];
    // РЕШЕНИЕ ЧЕЛОВЕКА НЕ ОТМЕНЯЕТСЯ АВТОМАТИКОЙ (ревью 194-1, 15.11.2026): карточку, которую
    // сотрудник удалил навсегда, сторож не заводит заново по тем же репликам — только по новым.
    const cutoff = humanDecisionCutoff(row.leadDraft, options.ignoreAttempts ? null : row.watchdogAttemptedAt);
    const texts = clientTexts(history, cutoff);
    let phone: string | null = null;
    let raw: string | null = null;
    let phoneText = "";
    for (const text of texts) {
      phone = phone ?? volunteeredClientPhone(text);
      if (phone) {
        phoneText = text;
        break;
      }
      raw = raw ?? unparsedPhoneAttempt(text);
    }
    let promise: ReturnType<typeof lastAgentContactPromise> = null;
    let unanswered: ReturnType<typeof unansweredClientTurn> = null;
    if (!phone && !raw) {
      // Обещания — только у тика: разовый добор (ignoreAttempts) по старым обещаниям карточек не заводит.
      if (options.promises ?? !options.ignoreAttempts) promise = lastAgentContactPromise(history, cutoff, now);
      if (promise) phoneText = promise.clientText;
      // WhatsApp: номер — сам отправитель. Клиент написал по делу, а ход бота ДОКАЗАННО не состоялся (27.11.2026).
      else {
        unanswered = failedTurns.get(row.id) ?? null;
        if (unanswered) phoneText = unanswered.texts.join("\n");
      }
      if (!promise && !unanswered) continue;
    }
    /**
     * РАЗГОВОР О РАБОТЕ — НЕ ПОТЕРЯННЫЙ ЛИД (авария 17.09.2026).
     *
     * С 17.09.2026 намерение «работа» даёт анкету кандидата и НИКОГДА не даёт
     * карточку клиента (messengers/conversation.ts, ветка `decision.reason ===
     * "работа"`). Для сторожа это значит, что такой диалог «без карточки» —
     * нормальное состояние, а не потеря: номер кандидата лежит в JobApplication,
     * его видно в разделе «Вакансии», и звать сюда ни приём, ни человека незачем.
     * Раньше сторож этого не знал и гонял приём по кругу.
     */
    const intent = (row.leadDraft as { intent?: string } | null)?.intent;
    if (intent === "job") continue;
    /**
     * То же для НОВОГО ЯДРА бота (14.11.2026): ядро держит тему разговора не в
     * leadDraft.intent, а в CustomerInquiry.publicState.topic, и анкету кандидата
     * пишет по запросу (JobApplication.customerInquiryId), а не по диалогу. Сторож
     * этого не видел: за 8–14.11 из 12 заведённых им карточек 9 были соискателями
     * работы — «Прочие обращения» без агента, мусор вместо лидов.
     */
    const coreTopic = coreTopicOf(row.customerInquiry?.publicState);
    if (coreTopic === "job") continue;
    let whatsappPhone: string | undefined;
    let basketCard = false;
    if (promise || unanswered) {
      // Приём ядра ещё в очереди (повторы при сбое Meta идут дольше PROMISE_GRACE_MS): он знает больше сторожа
      // (время звонка, «не звоните», объект) — не перебиваем его.
      if (await coreIntakeOwnsPromise(row.id, (promise ?? unanswered)!.at)) continue;
      // WhatsApp: номер известен и так — карточку заводит приём. Другие каналы: номера нет,
      // обещание пустое — это человеку (тревога ниже, phone остаётся null).
      const wa = row.channel === WHATSAPP_CHANNEL ? await resolveWhatsAppLeadIdentity(row.channel, row.subscriberId) : null;
      if (wa) {
        phone = wa.leadPhone;
        whatsappPhone = wa.waPhone;
        if (wa.existingClientId) {
          const card = await prisma.client.findUnique({ where: { id: wa.existingClientId }, select: { deletedAt: true } });
          basketCard = !!card?.deletedAt;
        }
      }
      // Несостоявшийся ход без номера отправителя — не заявка; карточку из Корзины удалил человек — не воскрешаем.
      if (unanswered && (!phone || basketCard)) continue;
      // Номер отправителя — наш собственный (агентство или сотрудник пишет со своего WhatsApp): не клиент (ревью #497, S5).
      if (phone && (isOwnAgencyNumber(phone) || (await findStaffPhone([phone])))) continue;
      // Направление неясно и никто из сотрудников разговор не вёл: в общую раздачу такое не шлём — пуши агентам и
      // руководству по «Салом, ?» хуже тишины (ревью #497, B1). Разговор с сотрудником — карточка ему же (S3).
      if (unanswered) {
        const intent = watchdogLeadDraft({ draft: row.leadDraft, coreTopic, history, promised: false }).intent;
        if (intent !== "buy" && intent !== "sell" && intent !== "rent" && !unanswered.staffAgentId) continue;
      }
    }
    found.push({
      conversationId: row.id,
      channel: row.channel,
      name: row.name,
      phone,
      raw,
      spamFlagged: !!row.spamFlaggedAt,
      phoneText,
      draft: row.leadDraft,
      history,
      coreTopic,
      inquiryId: row.customerInquiry?.id ?? null,
      ...(promise ? { promised: true, promisedAt: promise.at } : {}),
      ...(unanswered && phone ? { unanswered: true } : {}),
      ...(unanswered?.staffAgentId ? { staffAgentId: unanswered.staffAgentId } : {}),
      ...(promise?.refusalUnclear ? { refusalUnclear: true } : {}),
      ...(basketCard ? { basketCard: true } : {}),
      ...(whatsappPhone ? { whatsappPhone } : {}),
    });
  }
  const deleted = await deletedByHumanBefore(found);
  return withoutJobApplications(found.filter((r) => !deleted.has(r.conversationId)));
}

/**
 * Несостоявшиеся ходы WhatsApp, у которых СБОЙ ДОКАЗАН (ревью #497, B1). Молчание бота само по себе не сбой: ядро молчит
 * нарочно (спам, «ок», чужой репост, режим «только заявки» — общий список lib/customerIntendedSilence.ts). Доказательство —
 * одно из трёх: реплику записали мимо бота (heldRouting), сотрудник ответил руками, или у билета ядра этой реплики причина
 * молчания НЕ из списка намеренных. Билеты — одним запросом на пачку. Заглушённый спам и «не пишите» — не трогаем.
 */
async function provenFailedTurns(
  rows: ReadonlyArray<{ id: string; channel: string; messages: unknown; leadDraft: unknown; spamFlaggedAt: Date | null; watchdogAttemptedAt: Date | null; optedOutAt: Date | null }>,
  now: Date,
  ignoreAttempts: boolean
): Promise<Map<string, UnansweredTurn>> {
  const turns = new Map<string, UnansweredTurn>();
  for (const row of rows) {
    if (row.channel !== WHATSAPP_CHANNEL || row.spamFlaggedAt || row.optedOutAt) continue;
    const draft = row.leadDraft && typeof row.leadDraft === "object" ? (row.leadDraft as { spamMute?: unknown }) : null;
    if (draft && customerSpamMuteActive(customerSpamMuteFrom(draft.spamMute), now)) continue;
    const cutoff = humanDecisionCutoff(row.leadDraft, ignoreAttempts ? null : row.watchdogAttemptedAt);
    const turn = unansweredClientTurn((row.messages as ConversationMessage[] | null) ?? [], cutoff, now);
    if (turn) turns.set(row.id, turn);
  }
  const keys = [...new Set([...turns.values()].flatMap((t) => t.eventKeys))];
  const tickets = keys.length === 0 ? [] : await prisma.customerPropertyIngressTicket.findMany({
    where: { eventKey: { in: keys }, errorCode: { not: null } },
    select: { eventKey: true, errorCode: true },
    take: MAX_CONVERSATIONS * 4,
  });
  for (const [id, turn] of turns) if (!turnFailureProven(turn, tickets)) turns.delete(id);
  return turns;
}

/**
 * Доказан ли сбой хода (чистая функция, ревью #497, B1): реплика записана мимо бота, ответил сотрудник, или у билета
 * ядра причина молчания НЕ из общего списка намеренных (lib/customerIntendedSilence.ts — тот же, что у сторожа «клиент ждёт»).
 */
export function turnFailureProven(
  turn: Pick<UnansweredTurn, "held" | "staffReplied" | "eventKeys">,
  tickets: ReadonlyArray<{ eventKey: string; errorCode: string | null }>
): boolean {
  if (turn.held || turn.staffReplied) return true;
  const failed = new Set(tickets.filter((t) => t.errorCode && !customerTurnSilenceIsIntended(t.errorCode)).map((t) => t.eventKey));
  return turn.eventKeys.some((k) => failed.has(k));
}

/**
 * С какого момента реплики клиента — «новые» для сторожа и добора.
 *
 * Карточку удалили навсегда — routes/clients/card.ts отвязывает диалог и ставит
 * leadDraft.clientDeletedAt. Тот же номер в старых репликах — уже решённое человеком
 * дело: смотрим только реплики новее удаления (и новее прошлой попытки сторожа).
 * Удаления до этой правки отметки не имеют — их ловит deletedByHumanBefore ниже по
 * журналу действий (номер удалённой карточки).
 */
export function humanDecisionCutoff(leadDraft: unknown, lastAttempt: Date | null): Date | null {
  const deleted = clientDeletedAtOf(leadDraft);
  if (!deleted) return lastAttempt;
  return lastAttempt && lastAttempt > deleted ? lastAttempt : deleted;
}

/**
 * Это обещание — забота приёма ядра (lib/customerLeadOnlyCore.ts): по диалогу есть его задание, поставленное вместе
 * с обещанием или позже. Ждёт — не перебиваем (он знает время звонка, «не звоните», объект); отработал или сдался —
 * человека он уже позвал сам (alarmLeadOnlyIntake), вторая тревога не нужна.
 */
async function coreIntakeOwnsPromise(conversationId: string, promisedAt: Date): Promise<boolean> {
  const since = new Date(promisedAt.getTime() - 2 * 60_000);
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT 1 AS "n" FROM "BackgroundJob"
    WHERE "type" = ${CUSTOMER_LEAD_ONLY_INTAKE_JOB} AND "createdAt" >= ${since}
      AND "payload"->>'conversationId' = ${conversationId}
    LIMIT 1`;
  return rows.length > 0;
}

function clientDeletedAtOf(leadDraft: unknown): Date | null {
  const draft = (leadDraft && typeof leadDraft === "object" ? leadDraft : {}) as { clientDeletedAt?: unknown };
  const at = typeof draft.clientDeletedAt === "string" ? new Date(draft.clientDeletedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

/**
 * Удаление карточки ДО отметки clientDeletedAt (до 15.11.2026): стадия `done` без
 * карточки и без отметки — либо потерянная заявка (её надо завести), либо карточка,
 * удалённая человеком (её заводить нельзя). Различаем по журналу действий: окончательное
 * удаление пишет номер карточки (AuditLog PERMANENT_DELETE). Номер там есть — решение
 * человека, пропуск. Один запрос на пачку.
 */
async function deletedByHumanBefore(rows: PhoneWithoutLead[]): Promise<Set<string>> {
  const legacy = rows.filter((r) => r.phone && (r.draft as { stage?: unknown } | null)?.stage === "done" && !clientDeletedAtOf(r.draft));
  const tails = [...new Set(legacy.map((r) => phoneTail(r.phone!)))];
  if (!tails.length) return new Set();
  const found = await prisma.$queryRaw<Array<{ tail: string }>>`
    SELECT DISTINCT right(regexp_replace(coalesce("meta"->>'phone', ''), '[^0-9]', '', 'g'), 9) AS "tail" FROM "AuditLog"
    WHERE "action"='PERMANENT_DELETE' AND "entityType"='Client'
      AND right(regexp_replace(coalesce("meta"->>'phone', ''), '[^0-9]', '', 'g'), 9) = ANY(${tails})`;
  const deletedTails = new Set(found.map((f) => f.tail));
  return new Set(legacy.filter((r) => deletedTails.has(phoneTail(r.phone!))).map((r) => r.conversationId));
}

function coreTopicOf(publicState: unknown): string | null {
  const topic = (publicState as { topic?: unknown } | null)?.topic;
  return typeof topic === "string" ? topic : null;
}

/**
 * Анкета кандидата на этот диалог уже есть — значит номер не потерян, он лежит в
 * разделе «Вакансии» (авария 17.09.2026, второй рубеж к отсечке `intent === "job"`
 * выше). Намерение в черновике живёт только пока разговор идёт: перезапуск разбора,
 * ручная правка или смена темы могут его стереть, а анкета остаётся. ОДИН запрос на
 * всю пачку — отдельный на диалог дал бы N+1 ровно там, где кандидатов больше всего.
 */
async function withoutJobApplications(rows: PhoneWithoutLead[]): Promise<PhoneWithoutLead[]> {
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.conversationId);
  const inquiryIds = rows.map((r) => r.inquiryId).filter((id): id is string => !!id);
  const applications = await prisma.jobApplication.findMany({
    // Анкету старого пути ищем по диалогу, анкету ядра — по его запросу (customerInquiryId).
    where: { OR: [{ conversationId: { in: ids } }, ...(inquiryIds.length ? [{ customerInquiryId: { in: inquiryIds } }] : [])] },
    select: { conversationId: true, customerInquiryId: true },
    take: MAX_CONVERSATIONS,
  });
  const candidates = new Set(applications.flatMap((a) => [a.conversationId, a.customerInquiryId]).filter(Boolean));
  return rows.filter((r) => !candidates.has(r.conversationId) && !(r.inquiryId && candidates.has(r.inquiryId)));
}

/**
 * Номер уже есть в CRM под другой карточкой — тогда лид не потерян, а просто
 * пришёл вторым каналом (человек писал в Instagram, а звонил с того же номера).
 * Проверяем ОДНИМ запросом на всю пачку: отдельный запрос на диалог дал бы N+1
 * ровно там, где кандидатов больше всего — в первый прогон после выката.
 *
 * РАЗДЕЛ L, УРОВЕНЬ 2 (03.09.2026, план вечерней сессии §L). Раньше такие диалоги
 * просто ВЫЧИТАЛИСЬ из кандидатов на аларм «карточки нет» и на этом всё — сам
 * диалог оставался clientId=null НАВСЕГДА, пока кто-то не привяжет его руками.
 * Теперь: раз номер уже узнан, диалог сам привязывается к найденной карточке (см.
 * attachKnownClientConversations ниже) — агенту не нужно заводить дубль вручную,
 * он просто видит вторую переписку на уже знакомой карточке.
 */
async function withoutKnownClient(rows: PhoneWithoutLead[]): Promise<PhoneWithoutLead[]> {
  const known = await findKnownClientsByTail(rows);
  return rows.filter((r) => !r.phone || !known.has(phoneTail(r.phone)) || promiseNeedsIntake(r, known));
}

/**
 * Бот обещал звонок, а найденная по номеру карточка ни у кого не в работе («Прочее» от
 * входящего звонка, #2f2c7d → №857, 18.11.2026): простая привязка оставила бы обещание
 * висеть. Такой диалог идёт в приём — тот сам переведёт карточку и назначит агента.
 */
function promiseNeedsIntake(row: PhoneWithoutLead, known: Map<string, KnownClientMatch>): boolean {
  return !!row.promised && !!row.phone && !known.get(phoneTail(row.phone))?.assignedAgentId;
}

interface KnownClientMatch {
  id: string;
  shortId: number;
  assignedAgentId: string | null;
}

/** Карточки, чей номер (последние 9 цифр) совпадает хотя бы с одним диалогом
 *  из пачки — ключ карты: тот же хвост номера, что и у диалога. */
async function findKnownClientsByTail(rows: PhoneWithoutLead[]): Promise<Map<string, KnownClientMatch>> {
  const tails = [...new Set(rows.map((r) => (r.phone ? phoneTail(r.phone) : "")).filter(Boolean))];
  const result = new Map<string, KnownClientMatch>();
  if (tails.length === 0) return result;
  const known = await prisma.$queryRaw<Array<{ tail: string; id: string; shortId: number; assignedAgentId: string | null }>>`
    SELECT right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) AS "tail", "id", "shortId", "assignedAgentId"
    FROM "Client"
    WHERE "deletedAt" IS NULL
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ANY(${tails})
    LIMIT ${MAX_CONVERSATIONS}`;
  for (const k of known) result.set(k.tail, { id: k.id, shortId: k.shortId, assignedAgentId: k.assignedAgentId });
  return result;
}

/**
 * РАЗДЕЛ L, УРОВЕНЬ 2 — сам самолечащий шаг: диалог без карточки, чей номер узнан,
 * привязывается к найденной карточке автоматически, и её агент узнаёт о втором
 * канале (а не директор — это не потеря лида, обычная рабочая новость). Дедуп —
 * тот же приём, что и у аларма ниже: tag на пару (диалог, агент).
 */
async function attachKnownClientConversations(rows: PhoneWithoutLead[]): Promise<{ attached: number }> {
  const known = await findKnownClientsByTail(rows);
  if (known.size === 0) return { attached: 0 };

  let attached = 0;
  for (const row of rows) {
    if (!row.phone) continue;
    const match = known.get(phoneTail(row.phone));
    if (!match || promiseNeedsIntake(row, known)) continue;
    try {
      await prisma.botConversation.update({ where: { id: row.conversationId }, data: { clientId: match.id } });
    } catch (err) {
      // Гонка — диалог уже привязали (агент вручную, или другой тик) между
      // выборкой и этим update. Пропускаем, не считаем ошибкой.
      console.error("[alarm] phone-watchdog автопривязка диалога:", err instanceof Error ? err.message : err);
      continue;
    }
    attached++;
    if (!match.assignedAgentId) continue;
    // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
    const who = row.name?.trim() || `диалог ${channelLabel(row.channel)}`;
    const payload = {
      kind: "oversight" as const,
      title: `🔗 Ещё одна переписка: ${who}`,
      body: `Номер ${maskClientPhone(row.phone)} уже известен — новый диалог (${channelLabel(row.channel)}) привязан к вашей карточке автоматически`,
      url: `/clients/${match.shortId}`,
      tag: `duplicate-review-known-client-${row.conversationId}`,
    };
    try {
      await createNotifications([match.assignedAgentId], payload);
      void sendPushToAgents([match.assignedAgentId], payload).catch((err) =>
        console.error("[push] phone-watchdog автопривязка:", err)
      );
    } catch (err) {
      console.error("[alarm] phone-watchdog автопривязка уведомление:", err);
    }
  }
  return { attached };
}

/**
 * Сколько заявок сторож оформляет за один тик. Потолок нужен не ради базы, а ради
 * раздачи лидов: первый прогон после выката видит хвост за трое суток разом, и без
 * предела он вывалил бы его одной пачкой на дежурных агентов. Остаток никуда не
 * денется — следующий тик через час подберёт его.
 */
const MAX_AUTO_ACCEPTS_PER_TICK = 25;

/** Свой, меньший предел для карточек по несостоявшемуся ходу WhatsApp (27.11.2026): номер там не написан словами,
 *  и после сбоя ядра хвост может быть длинным — дежурным он приходит порциями, а обычные номера из текста не ждут. */
const MAX_UNANSWERED_ACCEPTS_PER_TICK = 10;

/** Предохранитель по частоте (владелец 15.09.2026) — см. shouldAlert в notifications.ts. */
const ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Оформить заявку тем же приёмом, что и живое сообщение. Возвращает исход, а не
 * бросает: сторож обязан дойти до конца списка, чем бы ни кончился один диалог.
 *
 * `await import` — не украшение: lib → messengers → lib даёт цикл импортов, а на
 * нём CI уже спотыкался (см. коммент к экспорту acceptLead).
 */
/**
 * Черновик для приёма. Старый путь копит намерение в leadDraft.intent сам; новое ядро
 * бота его не пишет (тема — в CustomerInquiry.publicState.topic), и без этого шага
 * КАЖДЫЙ клиент ядра уходил в «Прочие обращения» без агента (8–14.11.2026: покупатель
 * «1–2 комнаты» и продавец с ценой — оба «Прочее»), хотя бот обещал звонок агента.
 * Намерение берём из темы ядра, иначе — тем же кодовым разбором слов клиента, что у
 * моста ядра (ai/customerAgentIntake.ts). Все отсечки приёма (аренда, чужой город,
 * услуги, «направление не подтверждено») продолжают работать в classifyInbound.
 */
export function watchdogLeadDraft(row: Pick<PhoneWithoutLead, "draft" | "coreTopic" | "history" | "promised">): LeadDraft {
  const stored = ((row.draft as LeadDraft | null) ?? { stage: "chatting" }) as LeadDraft;
  // Бот обещал звонок агента, а модель записала «прочее» (#2f2c7d 18.11.2026: покупатель с бюджетом и районом,
  // intent "other"): с ним карточка ушла бы в «Прочие» без агента и обещание повисло бы снова. Направление решают
  // тема ядра и слова клиента, как при пустом намерении; приём перепроверит его сам.
  if (row.promised && stored.intent === "other") {
    // «Прочее» от модели — её уверенное «не клиент» (подрядчик, услуги). Перекрываем его, только если слова
    // клиента сами говорят о покупке или продаже; иначе карточка уйдёт в «Прочие» и сработает тревога.
    const role = customerAgentIntake(clientTexts(row.history).map((text) => ({ role: "user" as const, text }))).role;
    if (role === "buyer" || role === "seller") return { ...stored, intent: role === "buyer" ? "buy" : "sell", confident: undefined } as LeadDraft;
    return stored;
  }
  const draft = stored;
  // Старый путь (coreTopic === null) тоже читает слова клиента, если модель намерение
  // не записала (17.11.2026: пары «оформлена сторожем» → «намерение не определено»
  // шли из обоих путей). Разбор слов — один, ai/customerAgentRole.ts.
  if (draft.intent) return draft;
  // Аренда — тем же отказом приёма, что у старого пути (заявки на аренду не берём, владелец 21.08.2026).
  const fromTopic = row.coreTopic === "buyer" ? "buy" : row.coreTopic === "seller" ? "sell" : row.coreTopic === "rent" ? "rent" : null;
  if (fromTopic) return { ...draft, intent: fromTopic, confident: true };
  const texts = clientTexts(row.history);
  // Сдающий/снимающий — аренда по ЛЮБОЙ реплике, не только по реплике с номером (ревью 194-2):
  // словесный разбор ядра пишет арендодателя в «продавцы», а аренду не берём (владелец 21.08).
  // Снимающий — по ПОСЛЕДНЕМУ сигналу покупки/аренды в переписке: «снять → хотя нет, купить» — покупатель, долгий арендатор — арендатор (17.11.2026).
  const lastTenant = lastSignalIsRent(texts);
  if (texts.some((text) => customerRoleSignals(text).landlord) || lastTenant) return { ...draft, intent: "rent" };
  const role = customerAgentIntake(texts.map((text) => ({ role: "user" as const, text }))).role;
  const intent = role === "buyer" ? "buy" : role === "seller" ? "sell" : null;
  // Разбор слов — догадка, не уверенность: без `confident` приём перепроверит направление сам.
  return intent ? { ...draft, intent } : draft;
}

async function tryAcceptQuietly(row: PhoneWithoutLead): Promise<"accepted" | "accepted_other" | "declined" | "failed" | "reviewer"> {
  try {
    const { acceptLead } = await import("../messengers/conversation.js");
    const result = await acceptLead(
      row.conversationId,
      row.channel,
      row.name ?? undefined,
      row.phone!,
      // Сотрудник уже вёл переписку руками — карточка ему же, через ту же дверь назначения, что «клиент назвал агента»
      // (services/leads/intake.ts, requestedAgentId; доступность сотрудника там проверяется заново).
      row.staffAgentId
        ? { ...watchdogLeadDraft(row), requestedAgentId: row.staffAgentId, requestedAgentNote: "Сотрудник уже вёл эту переписку вручную: карточка заведена сторожем ему же" }
        : watchdogLeadDraft(row),
      // Тот же приём, что и в живом пути (messengers/conversation.ts): переписка
      // лежит в JSON-колонке, и её форма совпадает с ChatMessage.
      row.history as unknown as ChatMessage[],
      {
        deferAssignment: !(await isWithinWorkingHours()),
        ...(row.whatsappPhone ? { whatsappPhone: row.whatsappPhone } : {}),
        clientText: row.phoneText,
        extraPhones: extractAllPhones(row.phoneText),
        silent: true,
        // `phoneText` взят из УЖЕ сохранённой переписки — приём не должен записать
        // его туда второй раз и не должен двигать lastMessageAt (авария 17.09.2026:
        // именно этим сторож продлевал собственное окно и кормил петлю).
        fromHistory: true,
      }
    );
    // Проверяющий из Настроек: заявку не заводят нарочно (дверь — acceptLead), попытка засчитана, тревоги нет.
    if (result.reviewer) return "reviewer";
    if (!result.accepted) return "declined";
    // «accepted» без карточки — не успех (AI-DIALOGUE01): так приём отвечает и
    // опоздавшему из гонки, чей победитель жив или умер до привязки. Тик ставит
    // отметку попытки и больше этот диалог не трогает, поэтому ложный успех
    // прятал бы потерянный лид и от повтора, и от тревоги. Сверяем с базой.
    const linked = await prisma.botConversation.findUnique({
      where: { id: row.conversationId },
      select: { clientId: true, client: { select: { kind: true, assignedAgentId: true, assignmentRefusedAt: true, assignmentCompletedAt: true } } },
    });
    if (!linked?.clientId) {
      console.error(`[alarm] phone-without-lead автоприём: диалог ${row.conversationId} принят без карточки`);
      return "failed";
    }
    // Обещали звонок агента, а приём счёл обращение «прочим» (агентам не раздаётся): карточка есть,
    // но звонить некому. Это человеку, как в приёме ядра (lib/customerLeadOnlyCore.ts, «Прочие обращения»).
    // Ночная отсрочка (агента назначит утренняя волна) — не беда. «Прочее», отказ от назначения или закрытое
    // назначение — звонить некому, обещание висит.
    // Днём карточка без агента — тоже висящее обещание: ветка «клиент уже есть» меняет тип, но агента ставит не всегда
    // (ревью 19.11, случай №857).
    const card = linked.client;
    if (row.promised && card && !card.assignedAgentId &&
      (card.kind === "OTHER" || card.assignmentRefusedAt || card.assignmentCompletedAt || (await isWithinWorkingHours()))) {
      return "accepted_other";
    }
    return "accepted";
  } catch (err) {
    console.error("[alarm] phone-without-lead автоприём:", err instanceof Error ? err.message : err);
    return "failed";
  }
}

/**
 * Отметить, что автоприём по этому диалогу уже пробовали. Не бросает: сторож обязан
 * дойти до конца списка, а пропущенная отметка — это в худшем случае одна лишняя
 * попытка на следующем тике, а не остановка всего прохода.
 */
async function markWatchdogAttempted(conversationId: string, at: Date): Promise<void> {
  try {
    await prisma.botConversation.update({
      where: { id: conversationId },
      // Время НАЧАЛА прохода, а не конца: реплика, пришедшая, пока шёл приём, новее
      // отметки и попадёт в следующий тик (повторный разбор берёт только новые реплики).
      data: { watchdogAttemptedAt: at },
    });
  } catch (err) {
    console.error("[alarm] phone-watchdog отметка попытки:", err instanceof Error ? err.message : err);
  }
}

/**
 * Тик крона: найти, привязать то, что узнали (уровень 2), оформить что можно
 * (уровень 3), показать человеку только настоящих «потеряшек».
 */
export async function runPhoneLeadWatchdogTick(
  now: Date = new Date()
): Promise<{ alerted: number; accepted: number; attached: number }> {
  // Карточка уже есть, а номер из переписки на неё не лёг (ход не состоялся, сотрудник отвечал руками): тот же
  // проход дописывает его в карточку. Своя ошибка не останавливает сторожа карточек ниже.
  await sweepCardConversationPhones(now).then(
    (added) => { if (added > 0) console.log(`[cron] Номер из переписки дописан в карточку: ${added}`); },
    (err) => console.error("[alarm] phone-watchdog номера в карточку:", err instanceof Error ? err.message : err)
  );
  const found = await findPhonesWithoutLead(now);
  if (found.length === 0) return { alerted: 0, accepted: 0, attached: 0 };

  // Уровень 2 (03.09.2026, план §L): номер уже известен — диалог сам садится на
  // найденную карточку, агент видит вторую переписку вместо ручного дубля.
  // Привязка это данные, а не аларм: идёт круглосуточно, часы тишины её не
  // касаются (сам сигнал ниже уходит через очередь алармов, она их и держит).
  const { attached } = await attachKnownClientConversations(found);
  const candidates = await withoutKnownClient(found);
  if (candidates.length === 0) return { alerted: 0, accepted: 0, attached };

  /**
   * Сначала — приём. Всё, что оформилось, из очереди «показать человеку» уходит:
   * ради этого ступень и делалась.
   *
   * Последовательно, а не Promise.all: приём назначает агента, а распределение
   * считает портфели — пачка параллельных приёмов складывала бы лидов одному и
   * тому же дежурному, каждый со своим снимком счётчиков.
   */
  const leftForHuman: PhoneWithoutLead[] = [];
  let accepted = 0;
  let acceptedUnanswered = 0;
  /** Один человек на двух наших номерах в одном тике: вторая переписка ждёт следующего тика и садится на ту же карточку. */
  const takenTails = new Set<string>();
  for (const row of candidates) {
    const eligible = !!row.phone && !row.spamFlagged && !row.refusalUnclear && !row.basketCard;
    if (!eligible) {
      leftForHuman.push(row);
      continue;
    }
    // Предел тика — у каждой ветки свой: карточки по несостоявшемуся ходу WhatsApp не съедают предел обычных номеров
    // из текста (ревью #497, S1). Не влезшее в предел — работа следующего тика, тревогой не становится никогда.
    if (row.unanswered ? acceptedUnanswered >= MAX_UNANSWERED_ACCEPTS_PER_TICK : accepted >= MAX_AUTO_ACCEPTS_PER_TICK) continue;
    const tail = phoneTail(row.phone!);
    if (takenTails.has(tail)) continue;
    takenTails.add(tail);
    const outcome = await tryAcceptQuietly(row);
    // ОДНА ПОПЫТКА НА ДИАЛОГ, чем бы она ни кончилась (авария 17.09.2026). Отказ и
    // сбой тоже считаются попыткой: причина («аренда», «другая страна», упавший
    // приём) через 15 минут не изменится сама, а вот петля из повторов — изменится,
    // и именно она разослала клиентам сотни сообщений. Оба случая не теряются: они
    // уходят в leftForHuman ниже, и человек получает сигнал.
    await markWatchdogAttempted(row.conversationId, now);
    // Проверяющий из Настроек: заявку нарочно не заводят — попытка засчитана, не лид и не тревога.
    if (outcome === "reviewer") continue;
    if (outcome === "accepted") {
      if (row.unanswered) acceptedUnanswered++;
      else accepted++;
      // След в журнале: «карточка возникла сама, без сообщения клиенту» не должно
      // выглядеть загадкой ни для агента, ни при следующем разборе.
      void logSystemError(
        "ai",
        (row.promised
          ? `Заявка оформлена сторожем: бот пообещал звонок агента, а карточки не было (диалог ${row.conversationId}, номер ${maskClientPhone(row.phone!)}, `
          : row.unanswered
          ? `Заявка оформлена сторожем: клиент написал, а бот ему не ответил (диалог ${row.conversationId}, номер отправителя ${maskClientPhone(row.phone!)}, `
          : `Заявка оформлена сторожем: номер ${maskClientPhone(row.phone!)} был в переписке (диалог ${row.conversationId}, `) +
          // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
          `${channelLabel(row.channel)}), а карточки не было. Клиенту при этом ничего не отправлено.`
      );
      continue;
    }
    if (outcome === "accepted_other") {
      leftForHuman.push({ ...row, landedInOther: true });
      continue;
    }
    // Несостоявшийся ход WhatsApp: отказ приёма (аренда, другой город, услуги) — нормальный исход, номер в переписке
    // никто не «оставлял для звонка», и директора по нему звать незачем. Сбой — человеку, как всегда.
    if (row.unanswered && outcome === "declined") continue;
    // Отказ приёма (аренда, другая страна) и сбой одинаково остаются человеку:
    // в первом случае он закроет вопрос глазами, во втором — заведёт руками.
    leftForHuman.push(row);
  }

  if (leftForHuman.length === 0) return { alerted: 0, accepted: accepted + acceptedUnanswered, attached };

  let alerted = 0;
  for (const row of leftForHuman) {
    const tag = `alarm-phone-without-lead-${row.conversationId}`;
    // Предохранитель по частоте, ДО построения текста и постановки в очередь:
    // диалог остаётся «потеряшкой» на каждом следующем часовом тике, пока никто
    // не заведёт карточку руками, — без этой проверки push уходил бы директору
    // на каждый тик (см. doc-comment файла).
    if (!(await shouldAlert(tag, ALERT_MIN_INTERVAL_MS, now))) {
      // По этому диалогу руководство уже звали меньше суток назад: обещание отмечаем, оно уже на виду.
      if (row.promised) await markWatchdogAttempted(row.conversationId, now);
      continue;
    }

    // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
    const who = row.name?.trim() || `диалог ${channelLabel(row.channel)}`;
    const what = row.unanswered
      ? `Клиент написал в WhatsApp (номер ${maskClientPhone(row.phone!)}), бот ему не ответил, а карточку завести не удалось. Откройте переписку и заведите карточку`
      : row.landedInOther
      ? `Бот пообещал звонок агента (номер ${maskClientPhone(row.phone!)}), а карточка осталась без агента («Прочие», отказ или закрытое назначение). Позвоните клиенту или назначьте агента`
      : row.refusalUnclear
        ? `Бот пообещал звонок агента, а клиент потом, похоже, отказался от звонка${row.phone ? ` (номер ${maskClientPhone(row.phone)})` : ""}. Прочтите переписку и решите сами`
      : row.basketCard
        ? `Бот пообещал звонок агента, а номер ${maskClientPhone(row.phone!)} у карточки в Корзине. Сторож её не воскрешает: решите сами`
      : row.promised && !row.phone
      ? "Бот пообещал, что агент свяжется, но номера у бота нет и карточки нет. Напишите клиенту и попросите номер"
      : row.promised
        ? `Бот пообещал звонок агента (номер ${maskClientPhone(row.phone!)}), а карточка не оформилась`
        : row.phone
          ? `Номер ${maskClientPhone(row.phone)} есть в переписке, карточки в базе нет`
          : `Клиент прислал «${row.raw}» — на номер похоже, но разобрать нельзя (опечатка?)`;
    const payload = {
      kind: "oversight" as const,
      title: `📵 Заявка без карточки: ${who}`,
      // Когда/откуда(канал)/что — видно без перехода по ссылке.
      body: `${dushanbeDateTimeString(now)}, канал ${channelLabel(row.channel)}: ${what}${row.spamFlagged ? ". Диалог помечен как рассылка — проверьте, не ошибка ли" : ""}`,
      url: `/messages?open=${row.conversationId}`,
      tag,
    };
    try {
      // Часы алармов (владелец 07.09.2026): ставим в общую очередь вместо
      // мгновенной отправки — диалог уже сохранён, откладывается только сигнал.
      // Срочное: живой человек оставил номер, а карточки на него нет. Пока
      // это лежит в ленте непрочитанным, лид просто не существует для CRM.
      await enqueueDirectorAlert({ ...payload, level: "CRITICAL", recipientRoles: ["DIRECTOR", "ADMIN", "HEAD_OF_SALES"] });
      // След в «Здоровье системы»: пуш можно смахнуть, журнал остаётся — по нему
      // потом видно, как часто ступени 1-2 всё-таки промахиваются.
      void logSystemError(
        "ai",
        // Русское название канала вместо сырого кода из базы (ночная проверка 24.09.2026, находка №11).
        `[alarm] ${what} (диалог ${row.conversationId}, ${channelLabel(row.channel)}, ${who}). ` +
          `Откройте переписку и заведите карточку, если это настоящий клиент.`
      );
      alerted++;
      // Обещание без номера, с неясным отказом или с карточкой в Корзине приём не пробовал: отметка ПОСЛЕ постановки
      // тревоги — тревога по тем же репликам приходит один раз, а упавшая постановка повторится на следующем тике.
      if (row.promised) await markWatchdogAttempted(row.conversationId, now);
    } catch (err) {
      console.error("[alarm] phone-without-lead notification:", err);
    }
  }
  return { alerted, accepted: accepted + acceptedUnanswered, attached };
}

/** Сколько переписок с карточкой разбирает один проход: потолок выборки, остаток — следующему тику через 15 минут. */
const MAX_CARD_CONVERSATIONS = 300;

/**
 * НОМЕР ИЗ ПЕРЕПИСКИ — В УЖЕ ЗАВЕДЁННУЮ КАРТОЧКУ (27.11.2026).
 *
 * Живой ход дописывает номер в карточку сам (captureExplicitClientPhone в saveIncoming и в записи входящего ядра),
 * но только когда ход состоялся. Сообщение, которое ядро удержало (HELD), записывается мимо этой двери, а сотрудник,
 * ответивший руками, номер в карточку не переносит. Проход по фактам последних PHONE_WATCH_WINDOW_HOURS часов закрывает
 * и это, и вчерашнее (26.11) — один раз после выката.
 *
 * Дверь одна: captureExplicitClientPhone (lib/clientPhoneCapture.ts) — её правила целиком (только слова самого
 * клиента после назначения карточки, «мой номер …» или номер одним сообщением; номер сотрудника, номер чужой
 * карточки и уже записанный номер не пишутся). Идемпотентна: записанный номер второй раз не пишется, поэтому
 * повторный тик и повторная доставка вебхука ничего не меняют. Клиенту ничего не отправляется.
 */
export async function sweepCardConversationPhones(now: Date = new Date()): Promise<number> {
  // Рубильник читается один раз на проход (ревью #497, S6); дверь ниже сверит его ещё раз только для «просто номера».
  if (!(await automationSwitchOn("chatBarePhoneToCardEnabled"))) return 0;
  const since = new Date(now.getTime() - PHONE_WATCH_WINDOW_HOURS * 60 * 60 * 1000);
  // Отметка прохода (phoneSweepAt): переписка разбирается заново, только если после прошлого прохода в ней появилось
  // сообщение. Без неё одни и те же 300 строк читались бы каждый тик.
  const rows = await prisma.$queryRaw<Array<{ id: string; clientId: string; messages: unknown; phoneSweepAt: Date | null;
    phone: string | null; whatsappPhone: string | null; extraPhones: string[] | null }>>`
    SELECT bc."id", bc."clientId", bc.messages, bc."phoneSweepAt", c."phone", c."whatsappPhone", c."extraPhones"
    FROM "BotConversation" bc JOIN "Client" c ON c."id" = bc."clientId"
    WHERE bc."lastMessageAt" >= ${since} AND c."deletedAt" IS NULL
      AND (bc."phoneSweepAt" IS NULL OR bc."lastMessageAt" > bc."phoneSweepAt")
    ORDER BY bc."lastMessageAt" DESC
    LIMIT ${MAX_CARD_CONVERSATIONS}`;
  if (rows.length === 0) return 0;
  const { captureExplicitClientPhone, precedingQuestionOf } = await import("./clientPhoneCapture.js");
  const { bareOwnPhoneFact, explicitOwnPhoneFact, fullPhoneIdentity } = await import("./clientPhoneFacts.js");
  let added = 0;
  for (const row of rows) {
    const known = new Set([row.phone, row.whatsappPhone, ...(row.extraPhones ?? [])].filter((p): p is string => !!p).map(fullPhoneIdentity));
    const messages = Array.isArray(row.messages) ? (row.messages as ConversationMessage[]) : [];
    const after = row.phoneSweepAt && row.phoneSweepAt > since ? row.phoneSweepAt : since;
    for (const m of messages.slice(-LOOK_BACK_MESSAGES * 2)) {
      if (m.role !== "user" || m.by || m.silentCapture || m.attachments?.length || typeof m.content !== "string" || typeof m.at !== "string") continue;
      const at = new Date(m.at);
      if (Number.isNaN(at.getTime()) || at <= after) continue;
      const fact = explicitOwnPhoneFact(m.content, "CONVERSATION") ?? bareOwnPhoneFact(m.content, precedingQuestionOf(messages, m.content, at));
      // Номер уже на карточке — дверь не зовём (ревью #497, S6).
      if (!fact || known.has(fullPhoneIdentity(fact.phone))) continue;
      try {
        if (await captureExplicitClientPhone({ kind: "CONVERSATION", id: row.id, clientId: row.clientId, at, text: m.content })) {
          added++;
          known.add(fullPhoneIdentity(fact.phone));
        }
      } catch (err) {
        console.error("[alarm] phone-watchdog номер в карточку:", err instanceof Error ? err.name : "UnknownError");
      }
    }
  }
  // Отметка — только своей колонкой и сырым запросом: ни updatedAt, ни поля, на которые смотрит ревизия ядра, не трогаем.
  await prisma.$executeRaw`UPDATE "BotConversation" SET "phoneSweepAt" = ${now} WHERE "id" = ANY(${rows.map((r) => r.id)})`;
  return added;
}

/**
 * РАЗОВЫЙ ДОБОР ПОТЕРЯННЫХ НОМЕРОВ (14.11.2026, scripts/phone-leads-backfill-14-11.ts).
 *
 * Та же дверь, что и тик сторожа: тот же отбор, та же привязка к известной карточке,
 * тот же тихий приём (acceptLead) — второго пути заведения карточки здесь нет. Отличия
 * только два: окно шире (сутки × N) и прошлые попытки сторожа не мешают — именно они
 * и провалились из-за починенных сегодня дыр («done» без карточки, ядро без намерения).
 *
 * Чего добор НЕ делает: не зовёт руководство тревогами (это работа тика) и не трогает
 * диалоги, где карточку уже заводили и её потом убрал человек — номер в Корзине или
 * в журнале есть строка «Заявка оформлена сторожем … (диалог <id>». Решение человека
 * «удалить» скрипт не отменяет.
 */
export interface PhoneBackfillRow {
  conversationId: string;
  channel: string;
  /** Номер закрыт маской: отчёт добора печатается в консоль. */
  maskedPhone: string | null;
  coreTopic: string | null;
  intent: string | null;
  action: "attach" | "accept" | "skip";
  reason?: string;
  outcome?: "accepted" | "accepted_other" | "declined" | "failed" | "reviewer" | "attached";
  clientId?: string | null;
}

export async function backfillPhonesWithoutLead(input: { apply: boolean; windowHours: number; now?: Date }): Promise<PhoneBackfillRow[]> {
  const startedAt = input.now ?? new Date();
  const found = await findPhonesWithoutLead(startedAt, { windowHours: input.windowHours, ignoreAttempts: true });
  if (found.length === 0) return [];
  const known = await findKnownClientsByTail(found);
  const tails = [...new Set(found.map((r) => (r.phone ? phoneTail(r.phone) : "")).filter(Boolean))];
  const trashed = new Set(tails.length === 0 ? [] : (await prisma.$queryRaw<Array<{ tail: string }>>`
    SELECT DISTINCT right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) AS "tail" FROM "Client"
    WHERE "deletedAt" IS NOT NULL AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 9) = ANY(${tails})`).map((r) => r.tail));
  const ids = found.map((r) => r.conversationId);
  const madeBefore = new Set((await prisma.errorLog.findMany({
    where: { message: { startsWith: "Заявка оформлена сторожем" }, OR: ids.map((id) => ({ message: { contains: `(диалог ${id},` } })) },
    select: { message: true },
    take: MAX_CONVERSATIONS,
  })).flatMap((e) => ids.filter((id) => e.message.includes(`(диалог ${id},`))));

  const report: PhoneBackfillRow[] = [];
  const toAttach: PhoneWithoutLead[] = [];
  for (const row of found) {
    const base = { conversationId: row.conversationId, channel: row.channel, coreTopic: row.coreTopic,
      maskedPhone: row.phone ? maskClientPhone(row.phone) : null, intent: watchdogLeadDraft(row).intent ?? null };
    const skip = (reason: string) => report.push({ ...base, action: "skip", reason });
    if (!row.phone) { skip("номер не разобран — решает человек"); continue; }
    if (known.has(phoneTail(row.phone))) { toAttach.push(row); report.push({ ...base, action: "attach" }); continue; }
    if (row.spamFlagged) { skip("диалог помечен как рассылка"); continue; }
    if (trashed.has(phoneTail(row.phone))) { skip("карточка с этим номером в Корзине — удалил человек"); continue; }
    if (madeBefore.has(row.conversationId)) { skip("карточку по диалогу уже заводили, её удалили"); continue; }
    report.push({ ...base, action: "accept" });
  }
  if (!input.apply) return report;

  if (toAttach.length > 0) {
    await attachKnownClientConversations(toAttach);
    for (const r of report) if (r.action === "attach") r.outcome = "attached";
  }
  // Последовательно — по той же причине, что и в тике: распределение считает портфели.
  for (const r of report) {
    if (r.action !== "accept") continue;
    const row = found.find((f) => f.conversationId === r.conversationId)!;
    r.outcome = await tryAcceptQuietly(row);
    await markWatchdogAttempted(row.conversationId, startedAt);
    r.clientId = (await prisma.botConversation.findUnique({ where: { id: row.conversationId }, select: { clientId: true } }))?.clientId ?? null;
  }
  return report;
}
