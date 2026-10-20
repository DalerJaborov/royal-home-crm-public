import type { ConversationMessage, MessageSender } from "@royal-home/shared";
import { prisma } from "../db.js";
import { callAiText, type ChatMessage } from "../ai/client.js";
import { nowBlock } from "../ai/conversationTime.js";
import { dushanbeWallClock } from "./dushanbeTime.js";
import { applyShowingRequestInBackground, type ShowingActor, type ShowingRequest } from "./showingBooking.js";
import type { DeliveryTarget } from "./conversationState.js";

/**
 * Бот сам умеет назначать показ из своей переписки (см. showingBooking.ts) — но
 * только когда ход ведёт ОН. Пока агент отвечает клиенту вручную (полная передача
 * диалога человеку, см. OPERATOR_REPLY_PAUSE_MS в conversationDelivery.ts), точно
 * такая же договорённость («давайте завтра в пять») пролетала мимо: бот молчит,
 * а сам агент кнопки «назначить показ» не нажимал — договорённость оставалась
 * только словами в переписке, и в календаре её не было.
 *
 * Решение владельца 18.08.2026: гонять по КАЖДОМУ ручному ответу агента лёгкий
 * классификатор — не появилась ли в разговоре явная договорённость о дате/времени
 * показа — и, если появилась, назначать показ САМ, без ручных действий.
 *
 * Переиспользуется вся логика бота: тот же тип ShowingRequest, тот же разбор дня/
 * времени (resolveShowingSlot внутри bookShowing) и та же защита от дублей —
 * bookShowing сам решает «назначить/перенести/это уже назначено» по базе, здесь
 * это не переизобретается.
 */

/** Сколько последних реплик отдаём модели — тот же порядок величины, что и
 *  MAX_HISTORY_TO_MODEL у бота (leadQualifier.ts), но меньше: здесь не нужен
 *  весь разговор, а только последний обмен репликами вокруг договорённости. */
const MAX_HISTORY = 10;

/**
 * Дешёвый фильтр ДО вызова ИИ — той же идеи, что и у самого бота: гонять
 * классификатор на каждое «ок» и «спасибо» дорого и бессмысленно. Слова о дне,
 * времени, встрече — сигнал, что в реплике вообще может идти речь о показе.
 * Ложные срабатывания не страшны (лишний вызов ИИ дёшев), а ложные ПРОПУСКИ —
 * страшны, поэтому список нарочно широкий.
 *
 * 22.09.2026: «\bв\s?\d{1,2}\b» не совпадало НИ С ЧЕМ — перед кириллической
 * «в» границы \b не бывает (CLAUDE.md про \w и \b по русскому тексту). Из-за
 * этого «договорились, в 5» до разбора не доходило вовсе: слова «завтра» в
 * такой реплике нет, а времени с двоеточием тоже. Взяты явные границы слова
 * (тот же приём, что BW/EW в ai/wordBoundary.ts) и флаг u, без которого
 * \p{L} не работает.
 */
export const SHOWING_HINT_RE =
  /(показ|встрет|заед|подъед|приед|подход|завтра|сегодня|послезавтра|понедельник|вторник|сред[ауы]|четверг|пятниц|суббот|воскресен|утром|утро|днём|днем|вечером|вечер|\d{1,2}[:.]\d{2}|(?<![\p{L}\p{N}])в\s?\d{1,2}(?![\p{L}\p{N}]))/iu;

const SYSTEM_PROMPT =
  `Ты читаешь обрывок переписки продавца недвижимости (агент) с клиентом. Реплики "Агент:" — ` +
  `слова сотрудника компании, "Клиент:" — слова покупателя/арендатора, "Бот:" — более ранние ` +
  `сообщения автоматического бота (для контекста, не обязательно относятся к делу).\n\n` +
  `Задача: определить, ДОГОВОРИЛИСЬ ЛИ СТОРОНЫ О КОНКРЕТНОЙ ДАТЕ И ВРЕМЕНИ ПОКАЗА ОБЪЕКТА — ` +
  `неважно, кто это предложил первым (агент или клиент), важно, что обе стороны согласны и время ` +
  `названо конкретно (не "как-нибудь на неделе", а "завтра в 17:00", "в субботу утром" и т.п.).\n\n` +
  `Верни found=false, если: договорённости ещё нет, время расплывчатое настолько, что дату не ` +
  `вывести, речь не о показе объекта (например про звонок или доставку документов), либо ` +
  `договорённость уже явно отменена/перенесена в этом же обрывке на другое время (тогда бери ` +
  `последнее, финальное время).\n\n` +
  `day — одно из: "today", "tomorrow", "after_tomorrow" либо точная дата в формате "YYYY-MM-DD". ` +
  `time — "HH:MM" 24-часовым форматом; если названа только часть суток без часа — можно "morning"/` +
  `"afternoon"/"evening". propertyCode — код объекта из переписки (число после "код" или "№"), если он ` +
  `назван; иначе null — не выдумывай.` +
  nowBlock(dushanbeWallClock());

// type как массив (JSON Schema) Gemini не понимает — его схема инструментов это
// OpenAPI-подмножество, где "тип" всегда один, а необязательность поля — через
// nullable (см. тот же баг и разбор в topicLock.ts:118). До этой правки КАЖДЫЙ
// вызов detectOperatorShowingAgreement получал HTTP 400 "Proto field is not
// repeating, cannot start list" — детектор ручных показов не работал ни разу.
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "Есть ли явная договорённость о дате и времени показа" },
    day: { type: "string", nullable: true, description: "today | tomorrow | after_tomorrow | YYYY-MM-DD" },
    time: { type: "string", nullable: true, description: "HH:MM либо morning/afternoon/evening" },
    propertyCode: { type: "string", nullable: true, description: "Код объекта, если назван" },
  },
  required: ["found"],
} as const;

interface DetectorResult {
  found: boolean;
  day?: string | null;
  time?: string | null;
  propertyCode?: string | number | null;
}

/** Реплика для модели — с пометкой, кто говорит, чтобы "Агент сказал/клиент согласился"
 *  не путались между собой и с более ранними ходами бота. */
function speakerLabel(message: ConversationMessage): string {
  if (message.role === "user") return "Клиент";
  if (message.by?.kind === "agent") return "Агент";
  if (message.by?.kind === "manual") return "Агент";
  return "Бот";
}

function toChatMessages(history: ConversationMessage[]): ChatMessage[] {
  return history
    .filter((m) => (m.content ?? "").trim().length > 0)
    .map((m) => ({ role: m.role, content: `${speakerLabel(m)}: ${m.content}` }));
}

/**
 * Точка входа — вызывается фоново из conversationDelivery.ts после того, как
 * ручной ответ агента реально ушёл клиенту. Не бросает наружу: вызывающий уже
 * оборачивает в `.catch`, но и внутри ошибки на любом шаге просто останавливают
 * разбор — молчание безопаснее, чем сорвать доставку ответа клиенту.
 */
export async function detectOperatorShowingAgreement(
  target: DeliveryTarget,
  agentText: string,
  sender?: MessageSender
): Promise<void> {
  // Бот сам справляется со своими диалогами — классификатор нужен только когда
  // отвечает ЖИВОЙ человек. options?.sender не задан ("system") — тоже не агент:
  // это служебная рассылка CRM, там некому было "договориться" словами.
  if (!sender || sender.kind !== "agent") return;
  if (!SHOWING_HINT_RE.test(agentText)) return;

  const clientId =
    target.kind === "telegram"
      ? (await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId
      : (await prisma.botConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId;
  if (!clientId) return;

  const row =
    target.kind === "telegram"
      ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { messages: true } })
      : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { messages: true } });
  const allMessages = (Array.isArray(row?.messages) ? row.messages : []) as unknown as ConversationMessage[];
  if (allMessages.length === 0) return;

  const history = toChatMessages(allMessages.slice(-MAX_HISTORY));
  if (history.length === 0) return;

  const result = await callAiText<DetectorResult>({
    endpoint: "operator-showing-detect",
    simple: true,
    maxTokens: 300,
    system: SYSTEM_PROMPT,
    messages: history,
    schema: RESULT_SCHEMA,
  });
  if (!result?.found || !result.day || !result.time) return;

  const request: ShowingRequest = {
    action: "book",
    propertyCode: result.propertyCode ?? undefined,
    day: result.day,
    time: result.time,
  };
  // Договорился ЖИВОЙ агент своими словами, а не бот, — actor обязателен (найдено
  // 20.08.2026): без него запись и push подписывались «бот назначил показ» о
  // действии, которое агент только что сделал сам (см. комментарий у bookShowing).
  const actor: ShowingActor = { kind: "agent", agentId: sender.agentId, agentName: sender.agentName };
  // Дубли и перенос уже назначенного решает bookShowing по базе (та же логика,
  // что и у бота) — второй раз это здесь не проверяется.
  applyShowingRequestInBackground(clientId, request, target.kind === "telegram" ? "TELEGRAM" : target.channel, actor);
}
