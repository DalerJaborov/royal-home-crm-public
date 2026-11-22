import { formatClientCode, formatPropertyCode, isReadOnlyRole, SHOWING_NEXT_STEP_LABELS, type ShowingNextStep, type ShowingQuestionAnswer } from "@royal-home/shared";
import { loadAgentAccess } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { automationSwitchOn } from "../lib/automationSwitches.js";
import { describeError } from "../lib/describeError.js";
import { isWithinDushanbeWindow } from "../lib/dushanbeTime.js";
import {
  AGENT_ASK_END,
  AGENT_ASK_START,
  SAFETY_PUSH_AFTER_MS,
  answerShowingQuestion,
  closeQuestion,
  closedByFact,
  loadQuestionDetails,
  planShowingOutcomeQuestions,
  propertyLabel,
  questionTimeLabel,
  type ShowingQuestionDetails,
  type ShowingQuestionRow,
} from "../lib/showingQuestions.js";
import { logSystemError } from "../lib/systemError.js";
import { claimCallback } from "../lib/telegramCallbackClaim.js";
import { sendPushToAgent } from "../push.js";
import { answerCallbackQuery, editHtmlMessage, type TelegramCallbackQuery, type TelegramInlineButton } from "./api.js";
import { escapeHtml } from "./assistantReply.js";
import { clickerOf, sendStaffNotice } from "./staffNotice.js";

/**
 * ВОПРОСЫ О ПОКАЗЕ В ШАБНАМ (владелец 22.11.2026: «лучше показы делать уведомлением с
 * кнопками в Шабнам, там люди охотнее нажимают кнопку, и после разговора можно своими
 * словами отвечать Шабнам: да, у нас показ»).
 *
 * Здесь только Telegram: текст вопроса, кнопки, их нажатия и крон отправки. Что
 * значит ответ и как он записывается в CRM — lib/showingQuestions.ts (одна дверь с
 * экраном CRM). Сообщение идёт через общую дверь сообщений помощницы (sendStaffNotice,
 * вид `showing`): «🔕 Не присылать такое» и «не присылай мне такое» работают как у всех.
 *
 * Страховка — пуш в CRM (тот же вопрос стоит карточкой на Главной и в карточке клиента):
 *  - у агента нет Telegram или вид «показы» в Telegram выключен — пуш сразу;
 *  - спросили в Шабнам и нет ответа SAFETY_PUSH_AFTER_MS — один пуш.
 *
 * Свободный ответ («да, у нас показ завтра в шесть», голосом) идёт обычным ходом
 * помощницы: showingQuestionContext даёт ей открытые вопросы, она исполняет их своими
 * инструментами (book_showing, complete_task, reschedule_showing…), вопрос снимается фактом.
 */

const PREFIX = "sq:";
const SEND_BATCH = 50;

const STEP_CODES: Record<string, ShowingNextStep> = { a: "another_showing", p: "pick_others", c: "callback", r: "refused" };
const CODE_OF: Record<ShowingNextStep, string> = { another_showing: "a", pick_others: "p", callback: "c", refused: "r" };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clientLine(d: ShowingQuestionDetails): string {
  return `${escapeHtml(clip(d.client.fullName, 60))} · ${formatClientCode(d.client.shortId, d.client.kind)}`;
}

/** Текст и кнопки вопроса. Чистая функция — её проверяют тесты. */
export function renderShowingQuestion(d: ShowingQuestionDetails): { html: string; buttons: TelegramInlineButton[][] } {
  const time = questionTimeLabel(d.at);
  const id = d.q.id;
  if (d.q.kind === "OUTCOME") {
    const what = [d.property ? escapeHtml(propertyLabel(d.property)) : null, time].filter(Boolean).join(", ");
    return {
      html: `🏠 <b>У вас был показ?</b>\n${clientLine(d)}${what ? `\n${what}` : ""}`,
      buttons: [[
        { text: "✅ Да, был", callback_data: `${PREFIX}y:${id}` },
        { text: "✖ Нет", callback_data: `${PREFIX}x:${id}` },
      ]],
    };
  }
  const choices = d.property ? [d.property] : d.options;
  const lines = [
    "📅 <b>Договорились о показе?</b>",
    clientLine(d),
    `Когда: ${time ?? "время не поняла"}`,
    `Объект: ${d.property ? escapeHtml(propertyLabel(d.property)) : "не поняла"}`,
  ];
  if (d.q.quote) lines.push(`<i>«${escapeHtml(d.q.quote)}»</i>`);
  const canBook = !!time && choices.length > 0;
  lines.push("");
  lines.push(
    canBook
      ? d.property ? "Нажмите «Да» — запишу показ." : "Выберите объект — запишу показ."
      : "Ответьте мне своими словами, например: «да, ОБ-123 завтра в 18:00»."
  );
  if (canBook) lines.push("Если время или объект другие — напишите мне словами.");
  const buttons: TelegramInlineButton[][] = canBook
    ? choices.map((p) => [{
      text: d.property ? "✅ Да, записать показ" : `✅ ${clip(`${formatPropertyCode(p.shortId)} · ${p.title}`, 40)}`,
      callback_data: `${PREFIX}b:${id}:${p.shortId}`,
    }])
    : [];
  buttons.push([{ text: "✖ Нет, не договорились", callback_data: `${PREFIX}n:${id}` }]);
  return { html: lines.join("\n"), buttons };
}

function heldStepButtons(id: string): TelegramInlineButton[][] {
  return [
    [
      { text: `🔁 ${SHOWING_NEXT_STEP_LABELS.another_showing}`, callback_data: `${PREFIX}s:${id}:${CODE_OF.another_showing}` },
      { text: `🔎 ${SHOWING_NEXT_STEP_LABELS.pick_others}`, callback_data: `${PREFIX}s:${id}:${CODE_OF.pick_others}` },
    ],
    [
      { text: "📞 Думает, перезвонить завтра", callback_data: `${PREFIX}s:${id}:${CODE_OF.callback}` },
      { text: `👎 ${SHOWING_NEXT_STEP_LABELS.refused}`, callback_data: `${PREFIX}s:${id}:${CODE_OF.refused}` },
    ],
  ];
}

function notHeldButtons(id: string): TelegramInlineButton[][] {
  return [[
    { text: "📅 Перенесли", callback_data: `${PREFIX}r:${id}` },
    { text: "✖ Отменили", callback_data: `${PREFIX}c:${id}` },
  ]];
}

// ───────────────────────── отправка ─────────────────────────

async function pushQuestion(d: ShowingQuestionDetails): Promise<void> {
  const title = d.q.kind === "OUTCOME" ? "🏠 У вас был показ?" : "📅 Договорились о показе?";
  const time = questionTimeLabel(d.at);
  await sendPushToAgent(d.q.agentId, {
    kind: "showing",
    title,
    body: `${d.client.fullName}${time ? `, ${time}` : ""} — ответьте в Шабнам или в карточке клиента`,
    url: `/clients/${d.client.shortId}`,
    tag: `showing-question-${d.q.id}`,
  });
}

/** Отправить один вопрос: Шабнам, а если некуда — пуш в CRM. */
async function deliver(q: ShowingQuestionRow, now: Date): Promise<void> {
  const details = await loadQuestionDetails(q);
  if (!details) {
    await closeQuestion(q, { answer: "client_gone" }, now);
    return;
  }
  const { html, buttons } = renderShowingQuestion(details);
  const dedupKey = `showing-question:${q.id}`;
  const status = await sendStaffNotice({
    agentId: q.agentId,
    kind: "showing",
    html,
    buttons,
    dedupKey,
    subject: `${q.kind} ${details.client.shortId}`,
  });
  if (status === "sent" || status === "duplicate") {
    const notice = await prisma.staffNotice.findUnique({ where: { dedupKey }, select: { chatId: true, messageId: true } });
    await prisma.showingQuestion.updateMany({
      where: { id: q.id, telegramSentAt: null },
      data: { telegramSentAt: now, telegramChatId: notice?.chatId ?? null, telegramMessageId: notice?.messageId || null },
    });
    return;
  }
  // no-telegram / muted / failed — страховка сразу: вопрос стоит в CRM, пуш зовёт туда. Сбой Telegram
  // (бот заблокирован, сеть) не повторяем каждую минуту трое суток — одного пуша достаточно.
  await pushQuestion(details);
  await prisma.showingQuestion.updateMany({ where: { id: q.id, pushSentAt: null }, data: { pushSentAt: now } });
}

/**
 * Крон раз в минуту: завести «У вас был показ?», отправить наступившие вопросы,
 * продублировать пушем неотвеченные. Вне часов агента (08:00–22:00) никого не будит —
 * вопросы ждут утра. Выключенный рубильник снимает вопросы своего вида без отправки.
 */
export async function runShowingQuestionsTick(now: Date = new Date()): Promise<{ planned: number; sent: number; pushed: number }> {
  const planned = await planShowingOutcomeQuestions(now);
  if (!isWithinDushanbeWindow(AGENT_ASK_START, AGENT_ASK_END, now)) return { planned, sent: 0, pushed: 0 };
  const [agreementOn, outcomeOn] = await Promise.all([
    automationSwitchOn("showingAgreementAskEnabled"),
    automationSwitchOn("showingOutcomeAskEnabled"),
  ]);
  const enabled = (kind: string) => (kind === "AGREEMENT" ? agreementOn : outcomeOn);

  let sent = 0;
  const due = await prisma.showingQuestion.findMany({
    where: { status: "OPEN", askAt: { lte: now }, telegramSentAt: null, pushSentAt: null },
    orderBy: { askAt: "asc" },
    take: SEND_BATCH,
  });
  for (const q of due) {
    try {
      if (!enabled(q.kind)) {
        await closeQuestion(q, { answer: "switch_off" }, now);
        continue;
      }
      const fact = await closedByFact(q, now);
      if (fact) {
        await closeQuestion(q, fact, now);
        continue;
      }
      await deliver(q, now);
      sent++;
    } catch (err) {
      void logSystemError("telegram", `Вопрос о показе не отправлен (${q.id}): ${describeError(err)}`, { dedupKey: "showing-question-send" });
    }
  }

  let pushed = 0;
  const silent = await prisma.showingQuestion.findMany({
    where: { status: "OPEN", pushSentAt: null, telegramSentAt: { lte: new Date(now.getTime() - SAFETY_PUSH_AFTER_MS) } },
    orderBy: { telegramSentAt: "asc" },
    take: SEND_BATCH,
  });
  for (const q of silent) {
    try {
      const fact = await closedByFact(q, now);
      if (fact) {
        await closeQuestion(q, fact, now);
        continue;
      }
      const claimed = await prisma.showingQuestion.updateMany({ where: { id: q.id, pushSentAt: null }, data: { pushSentAt: now } });
      if (claimed.count === 0) continue;
      const details = await loadQuestionDetails(q);
      if (details) {
        await pushQuestion(details);
        pushed++;
      }
    } catch (err) {
      void logSystemError("api", `Пуш-страховка вопроса о показе не ушёл (${q.id}): ${describeError(err)}`, { dedupKey: "showing-question-push" });
    }
  }
  return { planned, sent, pushed };
}

// ───────────────────────── кнопки ─────────────────────────

async function editQuestion(query: TelegramCallbackQuery, html: string, buttons: TelegramInlineButton[][] | null): Promise<void> {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  if (chatId === undefined || !messageId) return;
  await editHtmlMessage(String(chatId), messageId, html, buttons).catch((err: unknown) =>
    console.error("[showing-question] правка сообщения:", describeError(err))
  );
}

/** Нажатие кнопки под вопросом о показе. true — нажатие наше (обработано или отклонено). */
export async function handleShowingQuestionCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith(PREFIX)) return false;
  const [action, questionId, extra] = data.slice(PREFIX.length).split(":");
  // Повторная доставка того же нажатия не исполняется заново.
  if (!(await claimCallback(query.id))) {
    await answerCallbackQuery(query.id);
    return true;
  }
  try {
    const clicker = await clickerOf(query);
    if (!clicker) {
      await answerCallbackQuery(query.id, "Привяжите аккаунт в личке с ботом");
      return true;
    }
    const access = await loadAgentAccess(clicker.id);
    if (!access?.isActive || isReadOnlyRole(access.role)) {
      await answerCallbackQuery(query.id, "Нет прав на это действие");
      return true;
    }
    const q = questionId ? await prisma.showingQuestion.findUnique({ where: { id: questionId } }) : null;
    if (!q) {
      await answerCallbackQuery(query.id, "Вопрос не найден");
      return true;
    }
    const canActForOthers = access.permissions.has("clients.assign");
    if (q.agentId !== clicker.id && !canActForOthers) {
      await answerCallbackQuery(query.id, "Это вопрос другого сотрудника");
      return true;
    }
    if (q.status !== "OPEN") {
      await answerCallbackQuery(query.id, "На этот вопрос уже ответили");
      await editQuestion(query, escapeHtml(query.message?.text ?? "Вопрос о показе"), null);
      return true;
    }
    // Имя — для нажавшего: руководитель с правом номеров увидит его целиком, агент — с маской.
    const details = await loadQuestionDetails(q, clicker.id);
    if (!details) {
      await answerCallbackQuery(query.id, "Клиент не найден");
      return true;
    }
    const head = renderShowingQuestion(details).html;

    // Промежуточные шаги — только меняют кнопки, в CRM ничего не пишут.
    if (action === "y") {
      await answerCallbackQuery(query.id);
      await editQuestion(query, `${head}\n\n✅ Показ был. Что дальше с клиентом?`, heldStepButtons(q.id));
      return true;
    }
    if (action === "x") {
      await answerCallbackQuery(query.id);
      await editQuestion(query, `${head}\n\nПоказа не было. Что случилось?`, notHeldButtons(q.id));
      return true;
    }
    if (action === "r") {
      await answerCallbackQuery(query.id);
      await editQuestion(query, `${head}\n\n📅 Напишите мне новое время, например «завтра в 18:00» — перенесу.`, null);
      return true;
    }

    let answer: ShowingQuestionAnswer | null = null;
    if (action === "n") answer = { action: "no" };
    if (action === "c") answer = { action: "cancelled", reason: "Отменили (ответ агента в Шабнам)" };
    if (action === "s" && extra && STEP_CODES[extra]) answer = { action: "held", next: STEP_CODES[extra] };
    if (action === "b" && extra && /^\d{1,9}$/.test(extra) && details.at) {
      const property = await prisma.property.findFirst({ where: { shortId: Number(extra), deletedAt: null }, select: { id: true } });
      if (property) answer = { action: "book", propertyId: property.id, at: details.at.toISOString() };
    }
    if (!answer) {
      await answerCallbackQuery(query.id, "Кнопка устарела");
      return true;
    }
    const result = await answerShowingQuestion({ questionId: q.id, actorId: clicker.id, canActForOthers, via: "telegram", answer });
    if (!result.ok) {
      await answerCallbackQuery(query.id, clip(result.error, 190));
      return true;
    }
    await answerCallbackQuery(query.id, "Записала");
    const more = answer.action === "held" && answer.next === "another_showing" ? "\nНазовите мне объект и время — запишу." : "";
    await editQuestion(query, `${head}\n\n✅ ${escapeHtml(result.message)}${more}`, null);
    return true;
  } catch (err) {
    void logSystemError("telegram", `Кнопка вопроса о показе: ${describeError(err)}`, { dedupKey: "showing-question-callback" });
    await answerCallbackQuery(query.id, "Не получилось, попробуйте ещё раз").catch(() => undefined);
    return true;
  }
}

// ───────────────────────── свободный ответ ─────────────────────────

/** Сколько назад отправленный вопрос ещё считается «тем, на что агент отвечает словами». */
const CONTEXT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Справка для хода помощницы в личке: открытые вопросы о показах, которые Шабнам
 * задала этому агенту. Без неё «да, был» или «перенесли на завтра в шесть» не к чему
 * привязать. Только коды и id, без имени клиента: имя пришло извне (ник Instagram) и
 * в справке, которую модель читает как нашу, ему не место. Пусто — вопросов нет.
 */
export async function showingQuestionContext(agentId: string, now: Date = new Date()): Promise<string> {
  const rows = await prisma.showingQuestion.findMany({
    where: { agentId, status: "OPEN", telegramSentAt: { gte: new Date(now.getTime() - CONTEXT_WINDOW_MS) } },
    orderBy: { telegramSentAt: "desc" },
    take: 3,
  });
  if (rows.length === 0) return "";
  const lines: string[] = [];
  for (const q of rows) {
    const d = await loadQuestionDetails(q);
    if (!d) continue;
    const time = questionTimeLabel(d.at) ?? "время не понято";
    const client = `${formatClientCode(d.client.shortId, d.client.kind)} (clientId ${d.client.id})`;
    if (q.kind === "OUTCOME") {
      lines.push(`- «У вас был показ?» ${client}, ${d.property ? `${formatPropertyCode(d.property.shortId)} (propertyId ${d.property.id})` : "объект не указан"}, ${time}, id показа ${q.showingId}. ` +
        "Был — complete_task с этим id показа (и create_task, если назван следующий шаг); перенесли — reschedule_showing; отменили — cancel_showing.");
    } else {
      const property = d.property ? `${formatPropertyCode(d.property.shortId)} (propertyId ${d.property.id})`
        : d.options.length ? `объект не понят, подходят: ${d.options.map((o) => `${formatPropertyCode(o.shortId)} (propertyId ${o.id})`).join(", ")}` : "объект не понят";
      lines.push(`- «Договорились о показе?» ${client}, ${property}, ${time}. Договорились — book_showing с этим clientId, объектом и временем, которые назвал сотрудник.`);
    }
  }
  if (lines.length === 0) return "";
  return `[Справка CRM, не слова сотрудника] Вы недавно спросили сотрудника о показах:\n${lines.join("\n")}\n` +
    "Если сообщение ниже — ответ на один из этих вопросов, исполните его этими инструментами. Если нет — справку не упоминайте.\n\n";
}
