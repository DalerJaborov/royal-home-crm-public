import { prisma } from "../db.js";
import {
  TelegramApiError,
  getChatMemberStatus,
  getChatTitle,
  isTelegramEnabled,
  probeChatAction,
  telegramMigratedChatId,
} from "../telegram/api.js";
import { migrateAssistantGroupChat } from "./assistantGroupMigration.js";
import { describeError } from "./describeError.js";
import { logSystemError } from "./systemError.js";

/**
 * СТОРОЖ ПОДКЛЮЧЁННЫХ ГРУПП ПОМОЩНИЦЫ (20.11.2026).
 *
 * Прод 20.11: Шабнам молчала в рабочей группе с 05.11. Группу превратили в супергруппу, у неё новый chat id,
 * а регистрация осталась на старом — обработчик группы для незарегистрированного чата молча выходит. Живое
 * служебное сообщение о переезде (assistantBot.ts) Telegram присылает один раз; если его не поймали (бот был
 * выключен, обработчик упал), повторно оно не придёт. Сторож спрашивает Telegram сам и ничего не пишет в группу.
 *
 * Что он делает с каждой зарегистрированной группой:
 *  1. getChatMember о самом боте. «member»/«administrator» — всё в порядке.
 *  2. Если Telegram отказал с parameters.migrate_to_chat_id — группа переехала: регистрация переносится дверью
 *     migrateAssistantGroupChat. Принимается от ЛЮБОГО метода, вернувшего параметр.
 *  3. Если бот «left»/«kicked» (именно так отвечает Telegram по старому id переехавшей группы), боту некуда
 *     показать индикатор, поэтому безопасно спросить sendChatAction: на переехавшую группу он отвечает отказом
 *     с тем же параметром. Нет параметра — бота в группе правда нет: одна запись в журнал в сутки, регистрация
 *     остаётся (вернут бота — группа заработает сама).
 *  4. Сетевой сбой, таймаут, 429/5xx — только строка в лог процесса: это не ответ Telegram про группу, и будить
 *     директора из-за секундного обрыва связи не за чем.
 */
const GROUPS_LIMIT = 200;
const ABSENT_REMINDER_MS = 24 * 60 * 60 * 1000;

export interface AssistantGroupSweepResult {
  checked: number;
  migrated: number;
  botAbsent: number;
  unknown: number;
}

type Verdict =
  | { kind: "present" }
  | { kind: "migrated"; newChatId: string }
  | { kind: "absent"; detail: string }
  | { kind: "unknown"; detail: string };

/** Отказ, в котором Telegram ясно сказал «этого чата для бота нет»; всё прочее — сбой связи, не ответ про группу. */
const isDefiniteRefusal = (err: unknown): boolean =>
  err instanceof TelegramApiError && (err.errorCode === 400 || err.errorCode === 403 || err.errorCode === 404);

async function judge(chatId: string): Promise<Verdict> {
  let status: string;
  try {
    status = (await getChatMemberStatus(chatId)).status;
  } catch (err) {
    const moved = telegramMigratedChatId(err);
    if (moved) return { kind: "migrated", newChatId: moved };
    return isDefiniteRefusal(err) ? { kind: "absent", detail: describeError(err) } : { kind: "unknown", detail: describeError(err) };
  }
  if (status !== "left" && status !== "kicked") return { kind: "present" };
  try {
    await probeChatAction(chatId);
    return { kind: "present" };
  } catch (err) {
    const moved = telegramMigratedChatId(err);
    if (moved) return { kind: "migrated", newChatId: moved };
    return isDefiniteRefusal(err) ? { kind: "absent", detail: `статус бота «${status}»: ${describeError(err)}` } : { kind: "unknown", detail: describeError(err) };
  }
}

async function groupLabel(chatId: string): Promise<string> {
  try {
    return (await getChatTitle(chatId)) ?? `чат ${chatId}`;
  } catch {
    return `чат ${chatId}`;
  }
}

let sweeping = false;

/** Один обход. Никогда не бросает и ничего не отправляет в группы. */
export async function sweepAssistantGroups(): Promise<AssistantGroupSweepResult> {
  const result: AssistantGroupSweepResult = { checked: 0, migrated: 0, botAbsent: 0, unknown: 0 };
  if (!isTelegramEnabled() || sweeping) return result;
  sweeping = true;
  try {
    const groups = await prisma.assistantTelegramGroup.findMany({
      select: { chatId: true },
      orderBy: { createdAt: "asc" },
      take: GROUPS_LIMIT,
    });
    for (const { chatId } of groups) {
      result.checked++;
      try {
        const verdict = await judge(chatId);
        if (verdict.kind === "migrated") {
          const outcome = await migrateAssistantGroupChat(chatId, verdict.newChatId);
          result.migrated++;
          console.log(`[assistant-group] группа стала супергруппой, регистрация перенесена (${outcome})`);
        } else if (verdict.kind === "absent") {
          result.botAbsent++;
          await logSystemError(
            "telegram",
            `Шабнам не состоит в подключённой группе «${await groupLabel(chatId)}» — верните бота в группу или отключите её. Пока бота нет, помощница там молчит. Ответ Telegram: ${verdict.detail}`,
            { dedupKey: `assistant-group-bot-absent:${chatId}`, dedupWindowMs: ABSENT_REMINDER_MS },
          );
        } else if (verdict.kind === "unknown") {
          result.unknown++;
          console.warn(`[assistant-group] проверка группы не удалась, повтор в следующий обход: ${verdict.detail}`);
        }
      } catch (err) {
        result.unknown++;
        await logSystemError("telegram", `Шабнам: проверка подключённой группы не удалась: ${describeError(err)}`, {
          dedupKey: `assistant-group-check-failed:${chatId}`,
        });
      }
    }
  } catch (err) {
    await logSystemError("telegram", `Шабнам: обход подключённых групп не удался: ${describeError(err)}`, {
      dedupKey: "assistant-group-sweep-failed",
    });
  } finally {
    sweeping = false;
  }
  return result;
}
