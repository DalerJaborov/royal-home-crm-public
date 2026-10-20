import { sellersWithPropertyInWork } from "./sellerCardState.js";
import type { ConversationMessage, ClientKind } from "@royal-home/shared";
import { prisma } from "../db.js";
import { inactiveLevelFields } from "./inactiveTrafficLight.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";
import { REAL_CALL_CONTACT_WHERE } from "./clientContact.js";
import { publishClientUpdated } from "./livePublish.js";

/**
 * «МОЛЧАЛИВЫЙ» КЛИЕНТ → АВТОМАТИЧЕСКИ В НЕАКТИВНЫЕ (владелец 30.08.2026,
 * дословно: «автоматически в неактивные тоже мы могли автоматизировать чтобы
 * молчаливые тоже шли туда»).
 *
 * До этого крона перевод в Неактивные был ТОЛЬКО ручным действием агента
 * (lib/clientWorkStatus.ts::deactivateClient, за гейтом canDeactivateWithReason —
 * тот требует зафиксированных попыток связаться). Здесь другой случай: клиент,
 * который сам ничего не пишет ботy НИ РАЗУ N дней подряд с момента НАШЕГО
 * последнего сообщения — работать тут агенту не с чем, звонить/писать
 * дополнительно не требуется, это не обход гейта, а отдельный источник входа
 * в тот же механизм (тот же workStatus=INACTIVE, тот же светофор дальше).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ПОЧЕМУ НЕ dialog.lastMessageAt (расхождение с первоначальной постановкой).
 * ═══════════════════════════════════════════════════════════════════════════
 * Задание предполагало, что `BotConversation.lastMessageAt` /
 * `TelegramConversation.lastMessageAt` — это «последнее сообщение ЛЮБОЙ
 * стороны», и молчание можно поймать сравнением `диалог.lastMessageAt >
 * client.lastClientMessageAt`. Это не так — проверено по самому коду:
 *
 *   - Комментарий у поля в схеме: «Момент последнего ЗАРЕГИСТРИРОВАННОГО
 *     ВХОДЯЩЕГО сообщения» (BotConversation.lastMessageAt).
 *   - lib/clientAutoStatus.ts, collectFacts, комментарий прямым текстом:
 *     «lastMessageAt — момент последнего ВХОДЯЩЕГО сообщения... Хронология
 *     пишется по действиям агента, и по ней «клиент ответил» не отличить от
 *     «агент написал»».
 *   - В коде (messengers/conversation.ts) `lastMessageAt` двигают ТОЛЬКО ветки
 *     входящего сообщения (saveIncoming, debounceAndMerge, drainPendingNow) —
 *     ни одна отправка ответа бота/агента его не трогает.
 *
 * То есть `диалог.lastMessageAt` и `Client.lastClientMessageAt` — практически
 * одно и то же значение (оба двигаются ровно тем же событием «клиент
 * написал», через notifyAgentOfClientMessage), и сравнение «диалог.lastMessageAt
 * > lastClientMessageAt» почти никогда не сработало бы как признак «слово
 * осталось за нами».
 *
 * НАСТОЯЩИЙ РАБОЧИЙ ПРИЗНАК — последняя реплика в самом массиве `messages`
 * (JSON, общая форма ConversationMessage из @royal-home/shared): у каждой
 * реплики есть `role` ("user"|"assistant") и `at` (ISO-момент записи,
 * appendConversationMessages проставляет его на КАЖДОЕ добавление, в обе
 * стороны). role="assistant" — это и бот, и ручной ответ агента из CRM (см.
 * MessageSender), то есть ровно «от нас», как и просил владелец. Тем же
 * приёмом уже пользуется cron.ts::sendFollowUps (`last.role !== "assistant"`) —
 * здесь он взят за основу, а не изобретён заново.
 *
 * НЕСКОЛЬКО ДИАЛОГОВ. У клиента может быть несколько BotConversation (разные
 * каналы) плюс TelegramConversation — берём диалог с САМОЙ СВЕЖЕЙ последней
 * репликой среди всех (а не первый попавшийся канал): именно она отвечает на
 * вопрос «чьё слово было последним в отношениях с этим клиентом вообще».
 *
 * ЧТО НЕ УЧИТЫВАЕТСЯ НАРОЧНО. ПОПЫТКИ агента дозвониться в расчёт не входят —
 * это отдельный вопрос, уже закрытый гейтом canDeactivateWithReason для
 * РУЧНОГО перевода.
 *
 * НО СОСТОЯВШИЙСЯ РАЗГОВОР — УЧИТЫВАЕТСЯ (19.09.2026, жалоба владельца:
 * «с клиентом, с которым поговорили, всё равно стоит плашка неактивный»).
 * Здесь стояло «звонки не входят вовсе», и признак молчания читался ровно
 * по переписке с ботом: агент дозванивался до клиента, они разговаривали,
 * договаривались о показе — а через пять дней тишины в чате карточка всё
 * равно уезжала в Неактивные. Молчит не тот, с кем вчера говорили голосом:
 * владелец просил автоматизировать МОЛЧАЛИВЫХ, а такой клиент отвечает,
 * просто не в чате. Поэтому ниже из кандидатов выбрасываются те, у кого
 * после отсечки есть отвеченный звонок, встреча или показ — ровно те
 * события, которые lib/clientAutoStatus.ts уже считает «клиент проявил
 * себя сам». Недозвон (outcome NO_ANSWER) признаком не является: это
 * попытка агента, а не ответ клиента.
 */

const FALLBACK_SILENT_DAYS = 5;
const DAY_MS = 86_400_000;

/** Статусы, с которых переводить в Неактивные автоматикой незачем: карточка и
 *  так уже вне обычной работы (потеряна/сделка закрыта/архив). */
const NOT_ELIGIBLE_STATUS = ["LOST", "DEAL_CLOSED", "ARCHIVED"] as const;

/** Стадии сделки, которые НЕ блокируют автоматику — сделка уже завершена или
 *  отменена, «активной» в смысле «агент ждёт документы» она не является. */
const TERMINAL_DEAL_STAGES = ["COMPLETED", "CANCELLED"] as const;

async function loadSilentDays(): Promise<number> {
  try {
    const s = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { silentClientInactiveDays: true },
    });
    return s?.silentClientInactiveDays ?? FALLBACK_SILENT_DAYS;
  } catch {
    return FALLBACK_SILENT_DAYS;
  }
}

interface DialogRow {
  messages: unknown;
  updatedAt: Date;
}

interface SilentCandidate {
  id: string;
  shortId: number;
  assignedAgentId: string;
  kind: ClientKind;
  botConversation: DialogRow[];
  telegramConversation: DialogRow | null;
}

/** Последняя реплика диалога: роль + момент. `at` реплики — источник истины;
 *  реплики без него (записанные до 01.08.2026) используют `updatedAt` строки
 *  диалога как ближайшее известное время записи. */
function dialogLastWord(
  dialog: DialogRow,
): { role: "user" | "assistant"; at: Date } | null {
  const arr = Array.isArray(dialog.messages)
    ? (dialog.messages as ConversationMessage[])
    : [];
  const last = arr[arr.length - 1];
  if (!last) return null;
  const parsed = last.at ? new Date(last.at) : null;
  const at =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed : dialog.updatedAt;
  return { role: last.role, at };
}

/** Самая свежая реплика среди ВСЕХ диалогов клиента (все каналы бота + Telegram). */
function freshestLastWord(
  candidate: SilentCandidate,
): { role: "user" | "assistant"; at: Date } | null {
  const dialogs: DialogRow[] = [
    ...candidate.botConversation,
    ...(candidate.telegramConversation ? [candidate.telegramConversation] : []),
  ];
  let best: { role: "user" | "assistant"; at: Date } | null = null;
  for (const d of dialogs) {
    const word = dialogLastWord(d);
    if (word && (!best || word.at.getTime() > best.at.getTime())) best = word;
  }
  return best;
}

export interface SilentAutoDeactivateSummary {
  deactivated: number;
}

/**
 * Запуск раз в сутки (см. cron.ts) — не срочный сигнал, молчание клиента не
 * требует немедленной реакции ночью.
 */
export async function runSilentClientAutoDeactivate(
  now: Date = new Date(),
): Promise<SilentAutoDeactivateSummary> {
  const silentDays = await loadSilentDays();
  const cutoff = new Date(now.getTime() - silentDays * DAY_MS);
  let deactivated = 0;
  let afterId: string | undefined;
  for (;;) {
    const candidates = await prisma.client.findMany({
      where: {
        ...(afterId ? { id: { gt: afterId } } : {}),
        deletedAt: null,
        workStatus: "ACTIVE",
        status: { notIn: [...NOT_ELIGIBLE_STATUS] },
        assignedAgentId: { not: null },
        reactivationOfferedToAgentId: null,
        contactProfiles: { none: { lastSeenAt: { gte: cutoff } } },
        // Клиент, который никогда не писал сам, не «замолчал» — это другой
        // случай (холодный лид), уже под другой автоматикой (clientAutoStatus).
        lastClientMessageAt: { not: null, lt: cutoff },
        OR: [{ returnedAt: null }, { returnedAt: { lt: cutoff } }],
        // Активная сделка — не застой, агент сам разберётся руками (см. правило
        // в задании владельца); COMPLETED/CANCELLED сделке не мешают.
        deals: { none: { stage: { notIn: [...TERMINAL_DEAL_STAGES] } } },
        /**
         * СОСТОЯВШИЙСЯ РАЗГОВОР ЗА ПОСЛЕДНИЕ N ДНЕЙ — НЕ МОЛЧАНИЕ (19.09.2026,
         * см. шапку файла). Отвеченный звонок, встреча и показ — то же
         * «клиент проявил себя сам», что и ответ в чате. Недозвон
         * (outcome = NO_ANSWER) и звонок без проставленного итога
         * (outcome = null) признаком не считаются: это попытка агента, а не
         * ответ клиента, и NOT IN по nullable-колонке их как раз не ловит.
         *
         * Условием запроса, а не проверкой в цикле: кандидатов до пятисот, и
         * отдельный запрос на каждого — ровно тот N+1, которого тут быть не
         * должно.
         */
        interactions: { none: { OR: [
          { ...REAL_CALL_CONTACT_WHERE, createdAt: { gte: cutoff } },
          { type: { in: ["MEETING", "SHOWING"] }, createdAt: { gte: cutoff } },
          { type: { in: ["MEETING", "SHOWING"] }, completedAt: { gte: cutoff } },
          { nextActionDate: { gt: now }, completedAt: null, declinedAt: null },
        ] } },
      },
      select: {
        id: true,
        shortId: true,
        assignedAgentId: true,
        kind: true,
        botConversation: { select: { messages: true, updatedAt: true } },
        telegramConversation: { select: { messages: true, updatedAt: true } },
      },
      orderBy: { id: "asc" }, take: 500,
    });
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].id;

    // Продавец с объектом в работе не «замолчал»: его объект в каталоге агента,
    // звонить незачем (владелец 23.09.2026, sellerCardState.sellersWithPropertyInWork).
    const sellersInWork = await sellersWithPropertyInWork(
      (candidates as SilentCandidate[])
        .filter((c) => c.kind === "SELLER")
        .map((c) => c.id),
    );

    for (const c of candidates as SilentCandidate[]) {
      if (sellersInWork.has(c.id)) continue;
      if (!c.assignedAgentId) continue; // не назначена — некому будет заниматься светофором
      const last = freshestLastWord(c);
      if (!last) continue; // диалога нет вовсе — не наш случай
      if (last.role !== "assistant") continue; // последнее слово было за клиентом
      if (last.at.getTime() > cutoff.getTime()) continue; // ещё не прошло нужное число дней

      try {
        const levelFields = await inactiveLevelFields(
          c.id,
          c.kind,
          "STOPPED_RESPONDING",
          undefined,
          now,
        );
        const written = await prisma.$transaction(async (tx) => {
          const updated = await tx.client.updateMany({
            where: {
              id: c.id, deletedAt: null, workStatus: "ACTIVE",
              status: { notIn: [...NOT_ELIGIBLE_STATUS] }, assignedAgentId: c.assignedAgentId,
              lastClientMessageAt: { lt: cutoff },
              reactivationOfferedToAgentId: null,
              contactProfiles: { none: { lastSeenAt: { gte: cutoff } } },
              OR: [{ returnedAt: null }, { returnedAt: { lt: cutoff } }],
              deals: { none: { stage: { notIn: [...TERMINAL_DEAL_STAGES] } } },
              interactions: { none: { OR: [
                { ...REAL_CALL_CONTACT_WHERE, createdAt: { gte: cutoff } },
                { type: { in: ["MEETING", "SHOWING"] }, createdAt: { gte: cutoff } },
                { type: { in: ["MEETING", "SHOWING"] }, completedAt: { gte: cutoff } },
                { nextActionDate: { gt: now }, completedAt: null, declinedAt: null },
              ] } },
            },
            data: {
              workStatus: "INACTIVE",
              inactiveEnteredAt: null,
              ...levelFields,
              // Реактивация к прежнему агенту (п.12) — см. assignment.ts/firstCall.ts/
              // reassignment.ts/clientWorkStatus.ts, тот же приём.
              lastAgentId: c.assignedAgentId,
            },
          });
          if (updated.count !== 1) return false;
          await logTimeline({
            clientId: c.id,
            actor: {
              kind: "system",
              source: "silentClientAutoDeactivate",
              subjectAgentId: c.assignedAgentId,
            },
            type: "SYSTEM",
            notes: `Клиент переведён в Неактивные автоматически: не отвечает ${silentDays} дн.`,
            tx,
          });
          return true;
        });
        if (!written) continue;
        publishClientUpdated({ clientId: c.id, agentIds: [c.assignedAgentId], stage: "INACTIVE" });
        deactivated++;
      } catch (err) {
        await logSystemError(
          "api",
          `Автопереход молчаливого клиента в Неактивные (клиент ${c.shortId}) не выполнен: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (candidates.length < 500) break;
  }
  return { deactivated };
}
