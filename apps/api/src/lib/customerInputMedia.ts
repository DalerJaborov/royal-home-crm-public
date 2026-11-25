import { Prisma } from "../generated/prisma/client.js";
import { prisma, type TxClient } from "../db.js";
import { fetchAttachments, storeFetchedAttachments, type AttachmentSource, type LostAttachment } from "../messengers/attachments.js";
import { deletePrivateFileByName } from "./privateFiles.js";
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
 * «[вложение без текста]». Скачивание и запись файла жили лишь в старом цикле
 * бота и в ядре — только ради разбора моделью и только для анкет на работу.
 *
 * Здесь «сохранить для сотрудника» отделено от «показать модели»:
 *   — качаем сразу, пока ссылка Meta жива (у WhatsApp она живёт минуты), без
 *     бюджета ИИ и без потолка «3 файла на ход» (тот потолок про модель);
 *   — пишем в закрытое хранилище тем же storeFetchedAttachments;
 *   — реплика уже есть — прикрепляем к ней (по `mid` сообщения Meta);
 *     её ещё нет (ядро пишет в своей очереди) — файлы ждут в таблице
 *     CustomerPendingMedia, и реплика забирает их В ТОЙ ЖЕ ТРАНЗАКЦИИ, где пишется
 *     (takePendingCustomerMedia). Ни перезапуск API, ни медленное ядро файл не
 *     теряют (ревью #428: прежнее ожидание жило в памяти 70 с);
 *   — не сохранилось — `attachmentsLost` с причиной на месте вложения.
 *
 * ГОНКА «реплика пишется, файл приходит». Обе стороны берут замок строки диалога
 * (FOR UPDATE): ledger — до записи реплики, здесь — до поиска реплики. Кто первый
 * взял замок, тот и решает: реплика без файла записана → мы видим её и
 * прикрепляем; мы первыми → оставили строку ожидания → ledger её забирает.
 *
 * Повтор вебхука: строка ожидания уникальна по (канал, собеседник, mid), реплика с
 * вложениями не перезаписывается — лишние копии файлов удаляются сразу.
 */

/** Сколько файлов одного сообщения сохраняем: пачка фото квартиры в Instagram бывает до 10. */
export const KEEP_MAX_FILES = 10;
/** Строка ожидания старше этого — ничья (реплику так и не записали). */
const PENDING_TTL_MS = 2 * 24 * 60 * 60 * 1000;

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

function fileNames(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.flatMap((f) => (f && typeof f === "object" && typeof (f as { file?: unknown }).file === "string" ? [(f as { file: string }).file] : []))
    : [];
}

/** Убрать наши копии, если они не понадобились (реплика уже со своими вложениями). */
function dropFiles(names: string[]): void {
  for (const name of names) {
    try {
      deletePrivateFileByName(name);
    } catch {
      /* уборка по сроку снимет */
    }
  }
}

export interface PendingCustomerMedia {
  attachments?: StoredAttachment[];
  attachmentsLost?: LostAttachment[];
}

/**
 * Для ledger: забрать файлы, ждущие эту реплику, — в его же транзакции и под
 * его замком диалога. Пусто — undefined.
 */
export async function takePendingCustomerMedia(
  tx: Pick<TxClient, "$queryRaw">,
  channel: string,
  subscriberId: string,
  mid: string | undefined
): Promise<PendingCustomerMedia | undefined> {
  if (!mid) return undefined;
  const rows = await tx.$queryRaw<{ files: unknown; lost: unknown }[]>`
    DELETE FROM "CustomerPendingMedia"
    WHERE "channel" = ${channel} AND "subscriberId" = ${subscriberId} AND "mid" = ${mid}
    RETURNING "files", "lost"`;
  const row = rows[0];
  if (!row) return undefined;
  const files = Array.isArray(row.files) ? (row.files as StoredAttachment[]) : [];
  const lost = Array.isArray(row.lost) ? (row.lost as LostAttachment[]) : [];
  return {
    ...(files.length ? { attachments: files } : {}),
    ...(lost.length ? { attachmentsLost: lost } : {}),
  };
}

type AttachResult = "attached" | "pending" | "already";

/**
 * Прикрепить к реплике или оставить ждать её. Под замком всех диалогов этого
 * собеседника в канале — тем же, что берёт ledger перед записью реплики.
 */
export async function attachOrPark(
  input: Pick<KeepCustomerInputMediaInput, "channel" | "subscriberId" | "mid">,
  files: StoredAttachment[],
  lost: LostAttachment[]
): Promise<{ result: AttachResult; conversationId?: string; drop: string[] }> {
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "CustomerPendingMedia" ("id", "channel", "subscriberId", "mid", "files", "lost")
      VALUES (gen_random_uuid()::text, ${input.channel}, ${input.subscriberId}, ${input.mid},
              ${JSON.stringify(files)}::jsonb, ${JSON.stringify(lost)}::jsonb)
      ON CONFLICT ("channel", "subscriberId", "mid") DO NOTHING
      RETURNING "id"`;
    // Строка уже была — это повтор вебхука. Ждут её файлы, наши копии лишние; но если
    // первая попытка ничего не скачала (только пометки), а эта скачала — ждать
    // должны наши файлы (повторное ревью #428).
    let drop: string[] = [];
    if (!inserted.length) {
      const updated = files.length
        ? await tx.$queryRaw<{ id: string }[]>`
            UPDATE "CustomerPendingMedia" SET "files" = ${JSON.stringify(files)}::jsonb, "lost" = ${JSON.stringify(lost)}::jsonb
            WHERE "channel" = ${input.channel} AND "subscriberId" = ${input.subscriberId} AND "mid" = ${input.mid}
              AND jsonb_array_length("files") = 0
            RETURNING "id"`
        : [];
      if (!updated.length) drop = fileNames(files);
    }

    const conversations = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BotConversation"
      WHERE "channel"::text = ${input.channel} AND "subscriberId" = ${input.subscriberId}
      ORDER BY "id" FOR UPDATE`;
    for (const { id } of conversations) {
      const row = await tx.botConversation.findUnique({ where: { id }, select: { messages: true } });
      const entry = row ? findEntry(row.messages, input.mid) : null;
      if (!row || !entry) continue;
      const parked = await takePendingCustomerMedia(tx, input.channel, input.subscriberId, input.mid);
      if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
        // Реплику сохранил старый путь (или ядро) со своими файлами: ждущие — лишние.
        return { result: "already" as const, drop: [...drop, ...fileNames(parked?.attachments)] };
      }
      if (parked?.attachments?.length) entry.attachments = parked.attachments as unknown as Prisma.JsonArray;
      // Пометки — ровно от этой попытки: старая «не скачалось» после удачного повтора врала бы.
      if (parked?.attachmentsLost?.length) entry.attachmentsLost = parked.attachmentsLost as unknown as Prisma.JsonArray;
      else if (parked?.attachments?.length) delete entry.attachmentsLost;
      await tx.botConversation.update({ where: { id }, data: { messages: row.messages as Prisma.InputJsonValue } });
      return { result: "attached" as const, conversationId: id, drop };
    }
    return { result: "pending" as const, drop };
  });
}

/**
 * Скачать, сохранить и прикрепить (или оставить ждать). Никогда не бросает:
 * зовётся в фоне после записи входящего, и её сбой не должен ронять разговор.
 */
export async function keepCustomerInputMedia(input: KeepCustomerInputMediaInput): Promise<AttachResult | "nothing" | "failed"> {
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
    for (let i = KEEP_MAX_FILES; i < sources.length; i++) lost.push({ kind: "file", reason: "too_many" });
    if (!files.length && !lost.length) return "nothing";

    const { result, conversationId, drop } = await attachOrPark(input, files, lost);
    dropFiles(drop);
    if (conversationId) void publishConversationUpdated("bot", conversationId);
    if (lost.length) {
      void logSystemError("meta", `Файл клиента не сохранён в CRM (${input.channel}): ${lost.map((l) => `${l.kind}/${l.reason}`).join(", ")}`, {
        dedupKey: `customer-input-media-lost:${input.channel}:${lost[0].reason}`,
      });
    }
    return result;
  } catch (err) {
    dropFiles(fileNames(files));
    void logSystemError("meta", `Файл клиента не сохранён в CRM (${input.channel}): ${describeError(err)}`, {
      dedupKey: `customer-input-media-error:${input.channel}`,
    });
    return "failed";
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

/**
 * Ночная уборка: строки ожидания старше двух суток — ничьи (реплику так и не
 * записали). Удаляются вместе с их файлами. Потолок за проход — как у уборки вложений.
 */
export async function cleanupStalePendingCustomerMedia(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - PENDING_TTL_MS);
  const rows = await prisma.$queryRaw<{ files: unknown }[]>`
    DELETE FROM "CustomerPendingMedia"
    WHERE "id" IN (SELECT "id" FROM "CustomerPendingMedia" WHERE "createdAt" < ${cutoff} ORDER BY "createdAt" LIMIT 500)
    RETURNING "files"`;
  for (const row of rows) dropFiles(fileNames(row.files));
  return { deleted: rows.length };
}
