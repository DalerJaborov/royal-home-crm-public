import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { fetchAttachments, storeFetchedAttachments, type AttachmentSource, type LostAttachment } from "../messengers/attachments.js";
import { deletePrivateFileByName } from "./privateFiles.js";
import { lockCustomerNative } from "./customerNativeLock.js";
import { publishConversationUpdated } from "./livePublish.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import type { StoredAttachment } from "../ai/shared.js";
import type { MessengerTurnInput } from "../messengers/turnTypes.js";

/**
 * ФАЙЛ КЛИЕНТА СОХРАНЯЕТСЯ ДЛЯ СОТРУДНИКА НЕЗАВИСИМО ОТ БОТА (25.11.2026).
 *
 * Жалоба владельца: «фото и видео клиентов приходят, но не открываются в CRM»;
 * на кадре — чат WhatsApp с сотрудником и строкой «Клиент прислал файл — в CRM
 * он не сохранился». Причина по коду: с переходом переписок на новое ядро
 * клиентского агента входящее записывается в историю `recordScopedCustomerInput`
 * (lib/customerQualifierLedger.ts) ТОЛЬКО ТЕКСТОМ, а при пустом тексте — меткой
 * «[вложение без текста]». Скачивание и запись файла жили лишь в старом пути
 * (messengers/conversation.ts → storeFetchedAttachments) и в ядре — только ради
 * разбора моделью и только для анкет на работу. Когда переписку ведёт
 * сотрудник (ход бота «held»), когда ядро разбирает сообщение позже в своей
 * очереди, когда кончился суточный бюджет ИИ — файл не сохранялся вовсе, и ни
 * одной строки в журнале об этом не было.
 *
 * Здесь «сохранить для сотрудника» отделено от «показать модели»:
 *   — качаем сразу, пока ссылка Meta жива (у WhatsApp она живёт минуты), без
 *     бюджета ИИ и без потолка «3 файла на ход» (тот потолок про модель);
 *   — пишем в закрытое хранилище тем же storeFetchedAttachments;
 *   — прикрепляем к той самой реплике клиента (по `mid` сообщения Meta). Ядро
 *     записывает реплику асинхронно, поэтому её ждём, а не требуем сразу;
 *   — не сохранилось — в реплике `attachmentsLost` с причиной, и экран пишет
 *     «видео больше 16 МБ — откройте в WhatsApp», а не общую фразу.
 *
 * Реплика, у которой вложения уже есть (их сохранил старый путь или ядро),
 * не перезаписывается: наши копии тогда удаляются, чтобы не копить дубли.
 */

/** Сколько файлов одного сообщения сохраняем: пачка фото квартиры в Instagram бывает до 10. */
export const KEEP_MAX_FILES = 10;
/** Ждём, пока ядро запишет реплику: очередь клиентского агента обычно успевает за секунды. */
const ATTACH_WAIT_MS = [1_000, 3_000, 6_000, 10_000, 20_000, 30_000];

export interface KeepCustomerInputMediaInput {
  channel: string;
  subscriberId: string;
  /** mid сообщения у платформы — по нему находится реплика клиента в истории. */
  mid: string;
  sources: AttachmentSource[];
}

type LedgerEntry = Prisma.JsonObject & { attachments?: unknown; attachmentsLost?: unknown };

function findEntry(messages: Prisma.JsonValue, mid: string): LedgerEntry | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && !Array.isArray(m) && m.role === "user" && m.mid === mid) return m as LedgerEntry;
  }
  return null;
}

async function findConversationWithMid(channel: string, subscriberId: string, mid: string): Promise<string | null> {
  // `jsonb::text` печатает поля с пробелом после двоеточия (см. findAttachmentOwnerClientId).
  const needle = `%"mid": ${JSON.stringify(mid)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "BotConversation"
    WHERE "channel" = ${channel} AND "subscriberId" = ${subscriberId} AND messages::text LIKE ${needle}
    ORDER BY "lastMessageAt" DESC NULLS LAST LIMIT 1`;
  return rows[0]?.id ?? null;
}

type AttachResult = "attached" | "already" | "missing";

/** Прикрепить к реплике под замком строки диалога (те же писатели истории берут его же). */
export async function attachToCustomerEntry(
  conversationId: string,
  mid: string,
  files: StoredAttachment[],
  lost: LostAttachment[]
): Promise<AttachResult> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockCustomerNative(tx, { kind: "bot", id: conversationId }))) return "missing";
    const row = await tx.botConversation.findUnique({ where: { id: conversationId }, select: { messages: true } });
    if (!row) return "missing";
    const entry = findEntry(row.messages, mid);
    if (!entry) return "missing";
    if (Array.isArray(entry.attachments) && entry.attachments.length > 0) return "already";
    if (files.length) entry.attachments = files as unknown as Prisma.JsonArray;
    if (lost.length) entry.attachmentsLost = lost as unknown as Prisma.JsonArray;
    await tx.botConversation.update({ where: { id: conversationId }, data: { messages: row.messages as Prisma.InputJsonValue } });
    return "attached";
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Убрать наши копии, если они не понадобились (реплика уже со своими вложениями). */
function dropFiles(files: StoredAttachment[]): void {
  for (const f of files) {
    if (!f.file) continue;
    try {
      deletePrivateFileByName(f.file);
    } catch {
      /* уборка по сроку снимет */
    }
  }
}

/**
 * Скачать, сохранить и прикрепить. Никогда не бросает: зовётся в фоне после
 * записи входящего, и её сбой не должен ронять ход разговора.
 */
export async function keepCustomerInputMedia(input: KeepCustomerInputMediaInput): Promise<AttachResult | "nothing"> {
  const sources = input.sources.filter((s) => !s.localPath);
  if (!sources.length || !input.mid) return "nothing";
  let files: StoredAttachment[] = [];
  try {
    const fetched = await fetchAttachments(sources, undefined, KEEP_MAX_FILES);
    files = await storeFetchedAttachments(fetched);
    const lost: LostAttachment[] = [...(fetched.lost ?? [])];
    // Скачали, но не записали (диск) — тоже пометка, а не тишина.
    const downloaded = fetched.images.length + fetched.audios.length + fetched.medias.length;
    for (let i = files.length; i < downloaded; i++) lost.push({ kind: "file", reason: "failed" });
    if (sources.length > KEEP_MAX_FILES) {
      for (let i = KEEP_MAX_FILES; i < sources.length; i++) lost.push({ kind: "file", reason: "too_big" });
    }
    if (!files.length && !lost.length) return "nothing";

    for (const wait of [0, ...ATTACH_WAIT_MS]) {
      if (wait) await sleep(wait);
      const conversationId = await findConversationWithMid(input.channel, input.subscriberId, input.mid);
      if (!conversationId) continue;
      const result = await attachToCustomerEntry(conversationId, input.mid, files, lost);
      if (result === "missing") continue;
      if (result === "already") {
        dropFiles(files);
        return "already";
      }
      void publishConversationUpdated("bot", conversationId);
      if (lost.length) {
        void logSystemError("meta", `Файл клиента не сохранён в CRM (${input.channel}): ${lost.map((l) => `${l.kind}/${l.reason}`).join(", ")}`, {
          dedupKey: `customer-input-media-lost:${input.channel}:${lost[0].reason}`,
        });
      }
      return "attached";
    }
    // Реплика так и не появилась (ядро удержало ход, сообщение не записано) —
    // файлы не к чему прикрепить: убираем, иначе они лежали бы ничьими.
    dropFiles(files);
    void logSystemError("meta", `Файл клиента скачан, но реплика ${input.channel} так и не записалась — файл не прикреплён`, {
      dedupKey: `customer-input-media-orphan:${input.channel}`,
    });
    return "missing";
  } catch (err) {
    dropFiles(files);
    void logSystemError("meta", `Файл клиента не сохранён в CRM (${input.channel}): ${describeError(err)}`, {
      dedupKey: `customer-input-media-error:${input.channel}`,
    });
    return "missing";
  }
}

/** То же в фоне — для мест, где ход разговора ждать скачивания не должен. */
export function keepCustomerInputMediaInBackground(input: Partial<KeepCustomerInputMediaInput> & { channel: string; subscriberId: string }): void {
  if (!input.mid || !input.sources?.length) return;
  void keepCustomerInputMedia(input as KeepCustomerInputMediaInput);
}

/** Файлы клиента — сотруднику, в путях, где реплику пишет не старый цикл
 *  (ход удержан, ядро, квалификатор). Старый цикл сохраняет файлы сам. */
export function keepIncomingMediaForStaff(input: Pick<MessengerTurnInput, "channel" | "subscriberId" | "messageId" | "attachments" | "fromStaff" | "skipSaveIncoming">): void {
  if (input.fromStaff || input.skipSaveIncoming) return;
  keepCustomerInputMediaInBackground({ channel: input.channel, subscriberId: input.subscriberId, mid: input.messageId, sources: input.attachments });
}
