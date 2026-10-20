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
}

const MAX_MESSAGES = 10;
const MAX_NOTES = 5;

/**
 * ПОСЛЕДНИЕ СООБЩЕНИЯ ПО ВРЕМЕНИ, А НЕ ПО КАНАЛАМ (CHANNEL-NEW-29, аудит 04.10.2026).
 *
 * Раньше строки шли «бот-диалоги, потом Telegram» и резались последние 10 массива:
 * 10 старых Telegram-реплик вытесняли свежее объяснение паузы из Instagram, и
 * директору уходило обвинение в уводе клиента. Теперь у каждой реплики своё время
 * (`at`, у старых записей без него берём время последнего сообщения диалога),
 * сортируем по нему и берём свежайшие.
 */
async function recentClientMessages(clientId: string): Promise<string[]> {
  const [botConvos, tgConvo] = await Promise.all([
    prisma.botConversation.findMany({
      where: { clientId },
      select: { messages: true, lastMessageAt: true },
      orderBy: { lastMessageAt: "desc" },
      take: 3,
    }),
    prisma.telegramConversation.findUnique({ where: { clientId }, select: { messages: true, lastMessageAt: true } }).catch(() => null),
  ]);

  const stamped: { at: number; line: string }[] = [];
  const collect = (raw: unknown, fallbackAt: Date | null) => {
    const messages = Array.isArray(raw) ? (raw as RawMessage[]) : [];
    for (const m of messages.slice(-MAX_MESSAGES)) {
      if (!m.content) continue;
      const parsed = m.at ? Date.parse(m.at) : NaN;
      stamped.push({
        at: Number.isFinite(parsed) ? parsed : (fallbackAt?.getTime() ?? 0),
        line: `${m.role === "user" ? "Клиент" : "Агент/бот"}: ${m.content}`,
      });
    }
  };
  for (const convo of botConvos) collect(convo.messages, convo.lastMessageAt);
  if (tgConvo) collect(tgConvo.messages, tgConvo.lastMessageAt);

  // Сортировка устойчивая: реплики без времени внутри одного диалога сохраняют порядок.
  stamped.sort((a, b) => a.at - b.at);
  return stamped.slice(-MAX_MESSAGES).map((x) => x.line);
}

async function recentInteractionNotes(clientId: string): Promise<string[]> {
  const interactions = await prisma.interaction.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: MAX_NOTES,
    select: { type: true, notes: true, createdAt: true },
  });
  return interactions.filter((i) => i.notes).map((i) => `[${i.type}] ${i.notes}`);
}

interface PauseCheckExtract {
  explained?: boolean;
  reason?: string;
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
  },
};

const SYSTEM_PROMPT =
  "Ты помогаешь понять, объяснил ли КЛИЕНТ агентства недвижимости Royal Home (Душанбе) сам паузу в общении, " +
  "или переписка/заметки просто обрываются без причины. Смотри только на слова САМОГО КЛИЕНТА (не агента). " +
  "Признаки объяснения: отложил показ/сделку, заболел, гости, уехал/отпуск, попросил время подумать или " +
  "перезвонить позже, передумал. Если ничего такого нет — explained=false. Ответ передавай через submit_reply.";

/**
 * Возвращает {explained: true} если сам клиент объяснил паузу — тогда аларм
 * не нужен, агент не виноват. {explained: false} — оснований для объяснения
 * не нашлось, аларм оправдан. При сбое ИИ считаем паузу НЕ объяснённой:
 * лучше лишний раз показать директору, чем молча пропустить реальный случай.
 */
export async function checkClientExplainedPause(
  clientId: string
): Promise<{ explained: boolean; reason?: string; unchecked?: boolean }> {
  try {
    const [messages, notes] = await Promise.all([recentClientMessages(clientId), recentInteractionNotes(clientId)]);
    if (messages.length === 0 && notes.length === 0) return { explained: false };

    const user = [
      notes.length > 0 ? `Заметки по карточке (от новых к старым):\n${notes.join("\n")}` : "",
      messages.length > 0 ? `Последние сообщения переписки:\n${messages.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000);

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
    if (!extract) return blocked ? { explained: false, unchecked: true } : { explained: false };
    return { explained: extract.explained === true, reason: extract.reason };
  } catch (err) {
    console.error("[ai] проверка «объяснил ли клиент паузу»:", err instanceof Error ? err.message : err);
    return { explained: false };
  }
}
