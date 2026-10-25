/**
 * «ОБЪЯСНИЛ ЛИ САМ КЛИЕНТ ПАУЗУ» (владелец 07.09.2026, разбор алармов —
 * lib/agentOffCrmAlarm.ts): перед тем как обвинять агента в тишине после
 * вопроса о номере, система должна перечитать последние сообщения/заметки по
 * клиенту и понять, не объяснил ли он паузу сам («отложил», «заболел», «гости»,
 * «уехал», «передумал») — если да, аларма быть не должно, это не вина агента.
 *
 * Вызывается ТОЧЕЧНО, не на каждое сообщение: только когда клиент уже прошёл
 * структурную проверку lib/agentOffCrmAlarm.ts (спросили номер + тишина/
 * заморозка N дней) — таких случаев мало, дорогой вызов ИИ на каждого не
 * штрафует бюджет (см. CLAUDE.md, «Token & cost economy»).
 *
 * НЕ ПУТАТЬ с ai/chatPropertyCount.ts: тот разбирает КАЖДОЕ сообщение в фоне
 * ради числа объектов; этот — редкий, целевой разбор ПОСЛЕДНИХ сообщений ради
 * одного да/нет перед тем, как разбудить директора.
 */
import { prisma } from "../db.js";
import { callAiText } from "./client.js";

interface RawMessage {
  role?: string;
  content?: string;
  at?: string;
  by?: string;
  contactCaptureExcluded?: boolean;
}

const MAX_MESSAGES = 10;
const MAX_NOTES = 5;

/**
 * ПОСЛЕДНИЕ СООБЩЕНИЯ ПО ВРЕМЕНИ, А НЕ ПО КАНАЛАМ (CHANNEL-NEW-29, аудит 04.10.2026).
 *
 * Раньше строки шли «бот-диалоги, потом Telegram» и резались последние 10 массива:
 * 10 старых Telegram-реплик вытесняли свежее объяснение паузы из Instagram, и
 * директору уходило обвинение в уводе клиента. Теперь у каждой реплики своё время
 * (`at`), сортируем по нему и берём свежайшие. Отсутствующую дату не выдумываем:
 * неполная история не разрешает отрицательный вывод об объяснении паузы.
 */
async function recentClientMessages(clientId: string, since?: Date): Promise<{ lines: string[]; uncertain: boolean }> {
  const [botConvos, tgConvo] = await Promise.all([
    prisma.botConversation.findMany({
      where: { clientId },
      select: { messages: true, lastMessageAt: true },
      orderBy: { lastMessageAt: "desc" },
      take: 3,
    }),
    prisma.telegramConversation.findUnique({ where: { clientId }, select: { messages: true, lastMessageAt: true } }),
  ]);

  const stamped: { at: number; line: string }[] = [];
  let uncertain = botConvos.length === 3;
  const collect = (raw: unknown) => {
    const messages = Array.isArray(raw) ? (raw as RawMessage[]) : [];
    if (messages.length > MAX_MESSAGES) uncertain = true;
    for (const m of messages.slice(-MAX_MESSAGES)) {
      if (m.role !== "user" || !m.content || m.by || m.contactCaptureExcluded) continue;
      const parsed = m.at ? Date.parse(m.at) : NaN;
      if (!Number.isFinite(parsed)) { uncertain = true; continue; }
      if (since && parsed < since.getTime()) continue;
      if (parsed > Date.now() + 60_000) { uncertain = true; continue; }
      stamped.push({
        at: parsed,
        line: `Клиент: ${m.content}`,
      });
    }
  };
  for (const convo of botConvos) collect(convo.messages);
  if (tgConvo) collect(tgConvo.messages);

  // Используем только реплики с собственным временем; порядок одинаковых дат устойчивый.
  stamped.sort((a, b) => a.at - b.at);
  return { lines: stamped.slice(-MAX_MESSAGES).map((x) => x.line), uncertain: uncertain || stamped.length > MAX_MESSAGES };
}

async function recentInteractionNotes(clientId: string, since?: Date): Promise<{ lines: string[]; uncertain: boolean }> {
  const interactions = await prisma.interaction.findMany({
    where: { clientId, type: "CALL", investigationOnly: false, transcript: { not: null }, ...(since ? { createdAt: { gte: since } } : {}) },
    orderBy: { createdAt: "desc" },
    take: MAX_NOTES,
    select: { transcript: true, createdAt: true },
  });
  let uncertain = interactions.length === MAX_NOTES;
  const lines = interactions.flatMap(i => {
    const quotes = (i.transcript ?? "").split(/\r?\n/).filter(line => /^\s*Клиент\s*:/iu.test(line)).map(line => line.trim());
    if (i.transcript && quotes.length === 0) uncertain = true;
    return quotes;
  });
  return { lines, uncertain };
}

interface PauseCheckExtract {
  explained?: boolean;
  reason?: string;
  quote?: string;
}

const schema = {
  type: "object",
  properties: {
    explained: {
      type: "boolean",
      description:
        "true — сам клиент явно объяснил паузу (отложил, заболел, гости, уехал/отпуск, передумал, попросил " +
        "перезвонить позже и т.п.). false — паузе нет объяснения от клиента, просто тишина.",
    },
    reason: {
      type: "string",
      description: "Если explained=true — коротко, чем именно объяснил (своими словами клиента). Иначе пусто.",
    },
    quote: { type: "string", description: "Дословная цитата САМОГО клиента, объясняющая паузу. Если её нет, пустая строка." },
  },
};

const SYSTEM_PROMPT =
  "Ты помогаешь понять, объяснил ли КЛИЕНТ агентства недвижимости Royal Home (Душанбе) сам паузу в общении, " +
  "или переписка/заметки просто обрываются без причины. Смотри только на слова САМОГО КЛИЕНТА (не агента). " +
  "Признаки объяснения: отложил показ/сделку, заболел, гости, уехал/отпуск, попросил время подумать или " +
  "перезвонить позже, передумал. При explained=true обязательна дословная quote из реплики клиента. Если ничего такого нет — explained=false. Ответ передавай через submit_reply.";

/**
 * Возвращает {explained: true} если сам клиент объяснил паузу — тогда аларм
 * не нужен, агент не виноват. {explained: false} — оснований для объяснения
 * не нашлось в проверенном контексте. При сбое, неполной истории или отсутствии
 * источников возвращается unchecked: вывод отложен, это не сигнал вины.
 */
export async function checkClientExplainedPause(
  clientId: string,
  options: { since?: Date } = {}
): Promise<{ explained: boolean; reason?: string; unchecked?: boolean }> {
  try {
    const [messages, notes] = await Promise.all([recentClientMessages(clientId, options.since), recentInteractionNotes(clientId, options.since)]);
    if (messages.lines.length === 0 && notes.lines.length === 0) return { explained: false, unchecked: true };

    const context = [
      notes.lines.length > 0 ? `Реплики клиента в публичных разговорах:\n${notes.lines.join("\n")}` : "",
      messages.lines.length > 0 ? `Последние сообщения клиента:\n${messages.lines.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = context.slice(0, 4000);

    /**
     * БЛОКИРОВКА GOOGLE — «НЕ ПРОВЕРЕНО», А НЕ «НЕ ОБЪЯСНЕНО» (аудит ботов
     * 10.10.2026, P1-8). Каждый день одни и те же несколько клиентов упирались в
     * PROHIBITED_CONTENT: журнал писал отказ ИИ, а тревога звучала так, будто
     * переписку прочли и объяснения не нашли. Прежний безопасный исход (тревога
     * остаётся) сохранён, но вызывающий знает, что проверки не было, и говорит
     * это прямо. В журнал — только id клиента (geminiClient.ts::logPromptBlocked).
     */
    let blocked = false;
    const extract = await callAiText<PauseCheckExtract>({
      endpoint: "off-crm-pause-check",
      clientId,
      onBlocked: () => {
        blocked = true;
      },
      simple: true,
      system: SYSTEM_PROMPT,
      user,
      maxTokens: 200,
      schema,
    });
    if (!extract || blocked || typeof extract.explained !== "boolean") return { explained: false, unchecked: true };
    if (extract.explained) {
      const quote = extract.quote?.trim();
      if (!quote || quote.length < 8 || ![...messages.lines, ...notes.lines].some(line => line.includes(quote))) return { explained: false, unchecked: true };
      return { explained: true, reason: extract.reason };
    }
    return messages.uncertain || notes.uncertain || context.length > 4000 ? { explained: false, unchecked: true } : { explained: false };
  } catch (err) {
    console.error("[ai] проверка паузы временно недоступна; вывод не сделан");
    return { explained: false, unchecked: true };
  }
}
